import { ethers, network, run } from "hardhat";

/**
 * Deploy RemexBridge to Base L2 (testnet or mainnet).
 *
 * Usage:
 *   npx hardhat run scripts/deploy.ts --network baseSepolia
 *   npx hardhat run scripts/deploy.ts --network base
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY  - Wallet that pays gas and becomes initial owner
 *   TREASURY_ADDRESS      - Where protocol fees go (multisig recommended)
 *   RELAYER_ADDRESS       - Backend hot wallet authorized to confirm/refund
 *   BASESCAN_API_KEY      - For contract verification on Basescan
 */
async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("\n🚀 RemexBridge Deployment");
  console.log("═".repeat(50));
  console.log(`  Network:   ${network.name}`);
  console.log(`  Deployer:  ${deployer.address}`);
  console.log(`  Balance:   ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);

  // ── CONFIGURATION ────────────────────────────────────────
  const config = getNetworkConfig(network.name);
  console.log("\n📋 Config:");
  console.log(`  USDC:      ${config.usdcAddress}`);
  console.log(`  Treasury:  ${config.treasury}`);
  console.log(`  Relayer:   ${config.relayer}`);
  console.log(`  Fee:       ${config.feeBasisPoints / 100}%`);

  // ── DEPLOY ───────────────────────────────────────────────
  console.log("\n📦 Deploying RemexBridge...");
  const RemexBridgeFactory = await ethers.getContractFactory("RemexBridge");

  const bridge = await RemexBridgeFactory.deploy(
    config.usdcAddress,
    config.treasury,
    config.feeBasisPoints,
    config.relayer
  );

  await bridge.waitForDeployment();
  const bridgeAddress = await bridge.getAddress();

  console.log(`  ✅ Deployed at: ${bridgeAddress}`);
  console.log(`  📊 Tx hash:    ${bridge.deploymentTransaction()?.hash}`);

  // ── VERIFY ───────────────────────────────────────────────
  if (network.name !== "hardhat" && network.name !== "localhost") {
    console.log("\n🔍 Waiting 5 blocks before verification...");
    await bridge.deploymentTransaction()?.wait(5);

    try {
      await run("verify:verify", {
        address: bridgeAddress,
        constructorArguments: [
          config.usdcAddress,
          config.treasury,
          config.feeBasisPoints,
          config.relayer,
        ],
      });
      console.log("  ✅ Verified on Basescan!");
    } catch (e: any) {
      if (e.message.includes("Already Verified")) {
        console.log("  ℹ️  Already verified.");
      } else {
        console.warn("  ⚠️  Verification failed:", e.message);
      }
    }
  }

  // ── OWNERSHIP TRANSFER (Ownable2Step) ────────────────────
  const gnosisSafe = process.env.GNOSIS_SAFE_ADDRESS;
  if (gnosisSafe) {
    if (!ethers.isAddress(gnosisSafe)) {
      throw new Error(`GNOSIS_SAFE_ADDRESS is not a valid Ethereum address: ${gnosisSafe}`);
    }
    console.log("\n🔐 Transferring ownership to Gnosis Safe...");
    console.log(`  Safe: ${gnosisSafe}`);

    const tx = await bridge.transferOwnership(gnosisSafe);
    await tx.wait();

    console.log(`  ✅ transferOwnership() sent (tx: ${tx.hash})`);
    console.log("  ⚠️  Transfer is PENDING — 2-step Ownable2Step.");
    console.log(`  The Safe must call acceptOwnership() on ${bridgeAddress} to finalize.`);
  } else {
    console.log("\n  ⚠️  GNOSIS_SAFE_ADDRESS not set — ownership stays with deployer.");
    console.log("      Set it in .env and re-run, or call transferOwnership() manually.");
  }

  // ── SUMMARY ──────────────────────────────────────────────
  console.log("\n🎉 Deployment Summary");
  console.log("═".repeat(50));
  console.log(`  Contract:  RemexBridge`);
  console.log(`  Address:   ${bridgeAddress}`);
  console.log(`  Network:   ${network.name}`);
  console.log(`  Explorer:  ${getExplorerUrl(network.name, bridgeAddress)}`);
  console.log(`  Owner:     ${gnosisSafe ? `${gnosisSafe} (pending acceptOwnership)` : `${deployer.address} (deployer — transfer manually)`}`);
  console.log("\n  Next steps:");
  console.log("  1. Update .env with CONTRACT_ADDRESS=" + bridgeAddress);
  if (gnosisSafe) {
    console.log(`  2. Gnosis Safe must call acceptOwnership() on ${bridgeAddress}`);
  } else {
    console.log("  2. Set GNOSIS_SAFE_ADDRESS and call transferOwnership()");
  }
  console.log("  3. Verify relayer wallet has ETH for gas");
  console.log("  4. Fund backend hot wallet with USDC for initial liquidity");
  console.log("  5. Run smoke tests against deployed contract\n");
}

function getNetworkConfig(networkName: string) {
  const configs: Record<string, {
    usdcAddress: string;
    treasury: string;
    relayer: string;
    feeBasisPoints: number;
  }> = {
    baseSepolia: {
      usdcAddress:    "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Official USDC on Base Sepolia
      treasury:       process.env.TREASURY_ADDRESS ?? "0x0000000000000000000000000000000000000001",
      relayer:        process.env.RELAYER_ADDRESS  ?? "0x0000000000000000000000000000000000000002",
      feeBasisPoints: 140, // 1.4%
    },
    base: {
      usdcAddress:    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Native USDC on Base Mainnet
      treasury:       process.env.TREASURY_ADDRESS!, // Required for mainnet
      relayer:        process.env.RELAYER_ADDRESS!,  // Required for mainnet
      feeBasisPoints: 140, // 1.4%
    },
    hardhat: {
      usdcAddress:    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      treasury:       "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      relayer:        "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
      feeBasisPoints: 140,
    },
  };

  const config = configs[networkName];
  if (!config) throw new Error(`No config for network: ${networkName}`);
  return config;
}

function getExplorerUrl(networkName: string, address: string) {
  if (networkName === "baseSepolia") return `https://sepolia.basescan.org/address/${address}`;
  if (networkName === "base") return `https://basescan.org/address/${address}`;
  return `local:${address}`;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
