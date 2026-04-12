import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * Smoke test — Sends a $10 USDC remittance to the deployed contract.
 *
 * Usage:
 *   npx hardhat run scripts/smokeTest.ts --network baseSepolia
 *   npx hardhat run scripts/smokeTest.ts --network base
 *
 * Required env vars:
 *   CONTRACT_ADDRESS       - Deployed RemexBridge address
 *   DEPLOYER_PRIVATE_KEY   - Wallet that signs the test tx (needs ETH + USDC)
 *
 * On Base Sepolia, get test USDC from:
 *   https://faucet.circle.com (USDC testnet faucet)
 *   or https://app.uniswap.org on Sepolia
 */

// ── MINIMAL ERC20 ABI ────────────────────────────────────────
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

// ── REMEX BRIDGE ABI (only what we need for smoke test) ──────
const BRIDGE_ABI = [
  "function sendRemittance(uint256 amount, bytes32 clabeHash, bytes32 recipientHash) returns (uint256)",
  "function getRemittance(uint256 id) view returns (tuple(address sender, uint256 amount, uint256 feeAmount, bytes32 clabeHash, bytes32 recipientHash, uint64 createdAt, uint64 resolvedAt, uint8 status))",
  "function computeFee(uint256 amount) view returns (uint256 fee, uint256 net)",
  "function feeBasisPoints() view returns (uint256)",
  "function minAmount() view returns (uint256)",
  "function maxAmount() view returns (uint256)",
  "function paused() view returns (bool)",
  "function totalRemittances() view returns (uint256)",
  "event RemittanceSent(uint256 indexed remittanceId, address indexed sender, uint256 amount, uint256 feeAmount, bytes32 indexed clabeHash, bytes32 recipientHash, uint64 timestamp)",
];

const STATUS_LABELS = ["Pending", "Processing", "Delivered", "Refunded", "Cancelled"];

// Test CLABE (valid Mexican CLABE for smoke tests)
const TEST_CLABE       = "021180040103290904";
const TEST_RECIPIENT   = "Juan Smoke Test";
const SMOKE_AMOUNT_USD = 10; // $10 USDC

async function main() {
  // ── SETUP ────────────────────────────────────────────────
  const contractAddress = process.env.CONTRACT_ADDRESS;
  if (!contractAddress || contractAddress === "0x...") {
    throw new Error("CONTRACT_ADDRESS not set in .env");
  }

  const [signer] = await ethers.getSigners();
  const networkName = network.name;
  const explorerBase = networkName === "base"
    ? "https://basescan.org"
    : "https://sepolia.basescan.org";

  const usdcAddress = networkName === "base"
    ? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    : "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

  console.log("\n🔥 RemexBridge Smoke Test");
  console.log("═".repeat(50));
  console.log(`  Network:   ${networkName}`);
  console.log(`  Contract:  ${contractAddress}`);
  console.log(`  Signer:    ${signer.address}`);

  const ethBalance = await ethers.provider.getBalance(signer.address);
  console.log(`  ETH:       ${ethers.formatEther(ethBalance)} ETH`);

  // ── CONNECT CONTRACTS ────────────────────────────────────
  const bridge = new ethers.Contract(contractAddress, BRIDGE_ABI, signer);
  const usdc   = new ethers.Contract(usdcAddress,     ERC20_ABI,  signer);

  // ── PRE-FLIGHT CHECKS ────────────────────────────────────
  console.log("\n🔍 Pre-flight checks...");

  const isPaused = await bridge.paused();
  check("Contract not paused",  !isPaused);

  const feeBps  = await bridge.feeBasisPoints();
  const minAmt  = await bridge.minAmount();
  const maxAmt  = await bridge.maxAmount();
  check("Fee = 140 bps (1.4%)", feeBps === 140n);
  check("Min = $10 USDC",       minAmt === 10_000_000n);
  check("Max = $2,999 USDC",    maxAmt === 2_999_000_000n);

  const usdcBalance = await usdc.balanceOf(signer.address);
  const amountMicro = BigInt(SMOKE_AMOUNT_USD) * 1_000_000n;
  console.log(`  USDC balance: $${formatUsdc(usdcBalance)}`);

  if (usdcBalance < amountMicro) {
    console.error(`\n  ✗ Insufficient USDC. Need $${SMOKE_AMOUNT_USD}, have $${formatUsdc(usdcBalance)}`);
    console.error("  Get testnet USDC at: https://faucet.circle.com");
    process.exitCode = 1;
    return;
  }
  check(`USDC balance ≥ $${SMOKE_AMOUNT_USD}`, usdcBalance >= amountMicro);

  // ── FEE PREVIEW ──────────────────────────────────────────
  const [fee, net] = await bridge.computeFee(amountMicro);
  console.log(`\n💸 Fee breakdown for $${SMOKE_AMOUNT_USD} USDC:`);
  console.log(`  Gross:   $${formatUsdc(amountMicro)}`);
  console.log(`  Fee:     $${formatUsdc(fee)} (${feeBps}bps)`);
  console.log(`  Net:     $${formatUsdc(net)} → converted to MXN`);

  // ── APPROVE ──────────────────────────────────────────────
  const currentAllowance = await usdc.allowance(signer.address, contractAddress);
  if (currentAllowance < amountMicro) {
    console.log("\n📝 Approving USDC...");
    const approveTx = await usdc.approve(contractAddress, amountMicro);
    await approveTx.wait();
    console.log(`  ✅ Approved (tx: ${approveTx.hash})`);
    console.log(`     ${explorerBase}/tx/${approveTx.hash}`);
  } else {
    console.log("\n  ✓ USDC already approved");
  }

  // ── SEND REMITTANCE ──────────────────────────────────────
  console.log("\n📤 Sending $10 test remittance...");

  const clabeHash     = ethers.keccak256(ethers.toUtf8Bytes(TEST_CLABE));
  const recipientHash = ethers.keccak256(ethers.toUtf8Bytes(TEST_RECIPIENT));

  const totalBefore = await bridge.totalRemittances();

  const sendTx = await bridge.sendRemittance(amountMicro, clabeHash, recipientHash);
  console.log(`  TX submitted: ${sendTx.hash}`);
  console.log(`  Waiting for confirmation...`);

  const receipt = await sendTx.wait();
  console.log(`  ✅ Confirmed in block ${receipt.blockNumber}`);
  console.log(`     ${explorerBase}/tx/${sendTx.hash}`);

  // ── VERIFY EVENT ─────────────────────────────────────────
  console.log("\n📋 Verifying RemittanceSent event...");

  const eventFragment = bridge.interface.getEvent("RemittanceSent")!;
  const emittedLog    = receipt.logs.find(
    (log: { topics: string[] }) => log.topics[0] === eventFragment.topicHash
  );

  if (!emittedLog) {
    check("RemittanceSent event emitted", false);
    process.exitCode = 1;
    return;
  }

  const decoded = bridge.interface.parseLog(emittedLog)!;
  const remittanceId: bigint = decoded.args.remittanceId;

  check("RemittanceSent event emitted",       true);
  check("sender matches signer",               decoded.args.sender.toLowerCase() === signer.address.toLowerCase());
  check("clabeHash matches",                   decoded.args.clabeHash === clabeHash);
  check("feeAmount = 1.4% of gross",           decoded.args.feeAmount === fee);
  check("net amount (amount in event) correct",decoded.args.amount === net);

  // ── VERIFY CONTRACT STATE ────────────────────────────────
  console.log("\n📊 Verifying contract state...");

  const remittance = await bridge.getRemittance(remittanceId);
  check("remittance.sender correct",           remittance.sender.toLowerCase() === signer.address.toLowerCase());
  check("remittance.amount = net",             remittance.amount === net);
  check("remittance.feeAmount correct",        remittance.feeAmount === fee);
  check("remittance.clabeHash correct",        remittance.clabeHash === clabeHash);
  check("remittance.status = Pending (0)",     remittance.status === 0n);
  check("remittance.resolvedAt = 0",           remittance.resolvedAt === 0n);

  const totalAfter = await bridge.totalRemittances();
  check("totalRemittances incremented",        totalAfter === totalBefore + 1n);

  // ── SUMMARY ──────────────────────────────────────────────
  console.log("\n🎉 Smoke Test Summary");
  console.log("═".repeat(50));
  console.log(`  Remittance ID: #${remittanceId}`);
  console.log(`  TX Hash:       ${sendTx.hash}`);
  console.log(`  Explorer:      ${explorerBase}/tx/${sendTx.hash}`);
  console.log(`  Amount sent:   $${formatUsdc(amountMicro)} USDC`);
  console.log(`  Fee charged:   $${formatUsdc(fee)} USDC`);
  console.log(`  Net to Mexico: $${formatUsdc(net)} USDC`);
  console.log(`  Status:        ${STATUS_LABELS[Number(remittance.status)]}`);
  console.log(`  CLABE hash:    ${clabeHash.slice(0, 18)}...`);
  console.log("\n  Backend listener should now pick up the event and");
  console.log("  call the Bitso off-ramp API to deliver MXN via SPEI.\n");
}

// ── HELPERS ──────────────────────────────────────────────────

function formatUsdc(micro: bigint): string {
  return (Number(micro) / 1_000_000).toFixed(2);
}

let hasFailure = false;
function check(label: string, passed: boolean): void {
  if (passed) {
    console.log(`  ✅ ${label}`);
  } else {
    console.log(`  ✗  ${label}`);
    hasFailure = true;
  }
}

main()
  .then(() => {
    if (hasFailure) {
      console.error("\n  Some checks FAILED.\n");
      process.exitCode = 1;
    }
  })
  .catch((err) => {
    console.error("\n  SMOKE TEST FAILED:", err.message ?? err);
    process.exitCode = 1;
  });
