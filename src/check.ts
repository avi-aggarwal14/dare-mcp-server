#!/usr/bin/env node
/** Setup verifier: confirms the Dare credentials work and prints the account's credit balance. */
import { loadConfig } from "./config.js";
import { ClerkTokenProvider } from "./auth.js";
import { DareRpcClient } from "./rpc.js";
import { DareService } from "./dare.js";
import { DareError } from "./errors.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.clientToken && !config.sessionToken) {
    console.error(
      "No Dare credentials found.\n" +
        "Run `npx dare-mcp-server setup` to connect your account, or set DARE_CLIENT_TOKEN.",
    );
    process.exit(1);
  }

  const auth = new ClerkTokenProvider(config);
  const dare = new DareService(new DareRpcClient(config, auth), config);

  process.stdout.write("Minting a Dare session token... ");
  const token = await auth.getToken();
  console.log(`ok (${token.slice(0, 12)}...)`);

  process.stdout.write("Reading credit balance... ");
  const balance = await dare.getCreditBalance();
  console.log("ok");
  console.log(JSON.stringify(balance, null, 2));

  process.stdout.write("Listing library items... ");
  const library: any = await dare.listLibrary(null, 3);
  console.log(`ok (${library?.items?.length ?? 0} shown)`);
  console.log("\nSetup looks good.");
}

main().catch((err) => {
  if (err instanceof DareError) {
    console.error(`\n${err.toAgentMessage()}`);
  } else {
    console.error(`\nUnexpected failure: ${err?.stack ?? err}`);
  }
  process.exit(1);
});
