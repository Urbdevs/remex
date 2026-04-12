import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * Pre-production verification checklist for RemexBridge.
 *
 * Usage:
 *   npx hardhat run scripts/verify.ts --network baseSepolia
 *   npx hardhat run scripts/verify.ts --network base
 *
 * Required env vars:
 *   CONTRACT_ADDRESS   - Deployed RemexBridge
 *   RELAYER_ADDRESS    - Backend wallet that should be authorized
 *   TREASURY_ADDRESS   - Protocol fee recipient
 *
 * Optional:
 *   GNOSIS_SAFE_ADDRESS - Expected owner (if ownership was already transferred)
 */

// ── CONSTANTS ────────────────────────────────────────────────
const EXPECTED_FEE_BPS    = 140n;    // 1.4%
const EXPECTED_MIN_USDC   = 10n   * 1_000_000n;   // $10
const EXPECTED_MAX_USDC   = 2999n * 1_000_000n;   // $2,999
const EXPECTED_DAILY_USDC = 5000n * 1_000_000n;   // $5,000

const USDC_BY_NETWORK: Record<string, string> = {
  base:        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  baseSepolia: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

// ── BRIDGE ABI (all view functions we verify) ────────────────
const BRIDGE_ABI = [
  "function usdc() view returns (address)",
  "function treasury() view returns (address)",
  "function feeBasisPoints() view returns (uint256)",
  "function minAmount() view returns (uint256)",
  "function maxAmount() view returns (uint256)",
  "function dailyLimit() view returns (uint256)",
  "function isRelayer(address) view returns (bool)",
  "function paused() view returns (bool)",
  "function totalRemittances() view returns (uint256)",
  "function totalVolumeSent() view returns (uint256)",
  "function totalFeesCollected() view returns (uint256)",
  "function pendingBalance() view returns (uint256)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
];

async function main() {
  const contractAddress = process.env.CONTRACT_ADDRESS;
  if (!contractAddress || contractAddress === "0x...") {
    throw new Error("CONTRACT_ADDRESS not set in .env");
  }

  const relayerAddress  = process.env.RELAYER_ADDRESS;
  const treasuryAddress = process.env.TREASURY_ADDRESS;
  const gnosisSafe      = process.env.GNOSIS_SAFE_ADDRESS;
  const networkName     = network.name;
  const explorerBase    = networkName === "base"
    ? "https://basescan.org"
    : "https://sepolia.basescan.org";

  console.log("\n🔎 RemexBridge — Pre-Production Verification");
  console.log("═".repeat(55));
  console.log(`  Network:   ${networkName}`);
  console.log(`  Contract:  ${contractAddress}`);
  console.log(`  Explorer:  ${explorerBase}/address/${contractAddress}`);

  const [verifier] = await ethers.getSigners();
  console.log(`  Verifier:  ${verifier.address}\n`);

  const bridge = new ethers.Contract(contractAddress, BRIDGE_ABI, ethers.provider);

  // Track overall result
  const results: { label: string; passed: boolean; detail?: string }[] = [];

  // ── 1. CONTRACT REACHABILITY ─────────────────────────────
  console.log("1️⃣  Contract Reachability");

  let bytecodeLength = 0;
  try {
    const code = await ethers.provider.getCode(contractAddress);
    bytecodeLength = (code.length - 2) / 2;
    result(results, "Contract deployed (has bytecode)", bytecodeLength > 0,
      `${bytecodeLength} bytes`);
  } catch {
    result(results, "Contract reachable", false, "RPC error");
  }

  // ── 2. PARAMETERS ────────────────────────────────────────
  console.log("\n2️⃣  Contract Parameters");

  const [feeBps, minAmt, maxAmt, dailyLmt, isPaused] = await Promise.all([
    bridge.feeBasisPoints(),
    bridge.minAmount(),
    bridge.maxAmount(),
    bridge.dailyLimit(),
    bridge.paused(),
  ]);

  result(results, "Fee = 140 bps (1.4%)",       feeBps === EXPECTED_FEE_BPS,       `${feeBps} bps`);
  result(results, "Min tx = $10 USDC",           minAmt === EXPECTED_MIN_USDC,      `$${fmt(minAmt)}`);
  result(results, "Max tx = $2,999 USDC",        maxAmt === EXPECTED_MAX_USDC,      `$${fmt(maxAmt)}`);
  result(results, "Daily limit = $5,000 USDC",   dailyLmt === EXPECTED_DAILY_USDC,  `$${fmt(dailyLmt)}`);
  result(results, "Contract not paused",         !isPaused, isPaused ? "PAUSED" : "active");

  // ── 3. TOKEN ADDRESS ─────────────────────────────────────
  console.log("\n3️⃣  Token Address");

  const usdcAddr         = (await bridge.usdc()).toLowerCase();
  const expectedUsdc     = USDC_BY_NETWORK[networkName]?.toLowerCase();
  result(results, "USDC address correct",
    !!expectedUsdc && usdcAddr === expectedUsdc,
    usdcAddr);

  // ── 4. TREASURY ──────────────────────────────────────────
  console.log("\n4️⃣  Treasury");

  const actualTreasury = (await bridge.treasury()).toLowerCase();
  if (treasuryAddress) {
    result(results, "Treasury matches TREASURY_ADDRESS",
      actualTreasury === treasuryAddress.toLowerCase(),
      actualTreasury);
  } else {
    result(results, "Treasury is set (non-zero)",
      actualTreasury !== "0x0000000000000000000000000000000000000000",
      actualTreasury);
    console.log("    ⚠️  Set TREASURY_ADDRESS in .env to verify it matches");
  }

  // ── 5. RELAYER ───────────────────────────────────────────
  console.log("\n5️⃣  Relayer Authorization");

  if (relayerAddress) {
    const isAuthorized = await bridge.isRelayer(relayerAddress);
    result(results, `Relayer ${relayerAddress.slice(0, 10)}… is authorized`, isAuthorized);
  } else {
    console.log("    ⚠️  RELAYER_ADDRESS not set in .env — skipping relayer check");
  }

  // ── 6. OWNERSHIP ─────────────────────────────────────────
  console.log("\n6️⃣  Ownership (Ownable2Step)");

  const owner        = await bridge.owner();
  const pendingOwner = await bridge.pendingOwner();

  result(results, "Owner is set (non-zero)",
    owner.toLowerCase() !== "0x0000000000000000000000000000000000000000",
    owner);

  if (gnosisSafe) {
    const ownerIsGnosis = owner.toLowerCase() === gnosisSafe.toLowerCase();
    const pendingIsGnosis = pendingOwner.toLowerCase() === gnosisSafe.toLowerCase();
    if (ownerIsGnosis) {
      result(results, "Owner = Gnosis Safe (transfer complete)", true, gnosisSafe);
    } else if (pendingIsGnosis) {
      result(results, "Gnosis Safe = pending owner (needs acceptOwnership)", false,
        `Safe must call acceptOwnership() on ${contractAddress}`);
    } else {
      result(results, "Owner = Gnosis Safe", false,
        `current owner: ${owner}, expected: ${gnosisSafe}`);
    }
  } else {
    console.log(`    ⚠️  GNOSIS_SAFE_ADDRESS not set — current owner: ${owner}`);
    if (pendingOwner && pendingOwner !== "0x0000000000000000000000000000000000000000") {
      console.log(`    ⚠️  Pending ownership transfer to: ${pendingOwner}`);
    }
  }

  // ── 7. STATS ─────────────────────────────────────────────
  console.log("\n7️⃣  Contract Statistics");

  const [total, volume, fees, pending] = await Promise.all([
    bridge.totalRemittances(),
    bridge.totalVolumeSent(),
    bridge.totalFeesCollected(),
    bridge.pendingBalance(),
  ]);

  console.log(`    Total remittances:    ${total}`);
  console.log(`    Lifetime volume:      $${fmt(volume)} USDC`);
  console.log(`    Lifetime fees:        $${fmt(fees)} USDC`);
  console.log(`    Pending balance:      $${fmt(pending)} USDC`);

  result(results, "Stats readable", true);

  // ── FINAL SUMMARY ────────────────────────────────────────
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const warned = results.length - passed - failed;

  console.log("\n" + "═".repeat(55));
  console.log(`  CHECKLIST: ${passed} passed  •  ${failed} failed`);
  console.log("═".repeat(55));

  if (failed > 0) {
    console.log("\n  Failed checks:");
    results
      .filter(r => !r.passed)
      .forEach(r => console.log(`    ✗  ${r.label}${r.detail ? ` — ${r.detail}` : ""}`));
    console.log();
    process.exitCode = 1;
  } else {
    console.log("\n  ✅  All checks passed — contract is production-ready.\n");
  }

  console.log(`  Explorer: ${explorerBase}/address/${contractAddress}\n`);
}

// ── HELPERS ──────────────────────────────────────────────────

function fmt(micro: bigint): string {
  return (Number(micro) / 1_000_000).toFixed(2);
}

function result(
  arr:    { label: string; passed: boolean; detail?: string }[],
  label:  string,
  passed: boolean,
  detail?: string,
): void {
  arr.push({ label, passed, detail });
  const icon = passed ? "  ✅" : "  ✗ ";
  const suffix = detail ? `  (${detail})` : "";
  console.log(`${icon} ${label}${suffix}`);
}

main().catch((err) => {
  console.error("\n  VERIFICATION FAILED:", err.message ?? err);
  process.exitCode = 1;
});
