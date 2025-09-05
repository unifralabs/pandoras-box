# Overview

`pandoras-box` is a command-line interface (CLI) tool for running stress tests on Ethereum-compatible blockchain
networks, such as Ethereum, Polygon, Hyperledger, and others. It is designed to be an essential tool for Ethereum client
developers looking to test the performance of their blockchain under high load.

## Key features

-   🚀 Batch transactions to make stress testing easier to orchestrate
-   🛠 Multiple stress testing modes: EOA, ERC20, and ERC721
-   💰 Distributed transaction stress testing through subaccounts
-   💸 Automatic subaccount fund top-up
-   📊 Detailed statistics calculation
-   📈 Output cycle run results to a file

# Usage example

To run a stress test with `pandoras-box`, you will need to have Node.js and npm / yarn installed on your system.

1. Install `pandoras-box` using npm / yarn:

```bash
npm install -g pandoras-box
```

2. Run the stress test by specifying the options for the test:

```bash
pandoras-box -url http://127.0.0.1:10002 -m "erupt oven loud noise rug proof sunset gas table era dizzy vault" -t 100 -b 5000 -o ./myOutput.json
```

This will run a stress test on the Ethereum-compatible blockchain network with a JSON-RPC endpoint
at `http://127.0.0.1:10002`, using the mnemonic `erupt oven loud noise rug proof sunset gas table era dizzy vault` to
generate the subaccounts. The test will send out 100 transactions in maximum batches of 5000, and the results will be
output to a file called `myOutput.json`.

For any stress test run, there need to be funds on a specific address.
The address that is in charge of funds distribution to subaccounts is the **first address** with index 0 in the
specified mnemonic. Make sure this address has an appropriate amount of funds before running the stress test.

![Banner](.github/demo.gif)

`pandoras-box` supports the following options:

```bash
Usage: pandoras-box [options]

A small and simple stress testing tool for Ethereum-compatible blockchain clients

Options:
  -V, --version                        output the version number
  -url, --json-rpc <json-rpc-address>  The URL of the JSON-RPC for the client
  -m, --mnemonic <mnemonic>            The mnemonic used to generate spam accounts
  -s, -sub-accounts <sub-accounts>     The number of sub-accounts that will send out transactions (default: "10")
  -t, --transactions <transactions>    The total number of transactions to be emitted (default: "2000")
  --mode <mode>                        The mode for the stress test. Possible modes: [EOA, ERC20, ERC721] (default: "EOA")
  -o, --output <output-path>           The output path for the results JSON
  -b, --batch <batch>                  The batch size of JSON-RPC transactions (default: "20")
  -h, --help                           display help for command
```

## Installing locally

`pandoras-box` can be installed locally using the git repository. A recent version of Node.js and yarn is required.

1. Clone the git repository

```bash
git clone https://github.com/madz-lab/pandoras-box.git
```

2. Build the source (from the repository root)

```bash
yarn build
```

The `yarn build` command will compile the TypeScript files locally into the `bin` folder, and run a `chmod` command
for enabling execution.

3. Link the command (from the repository root)

```bash
yarn link
```

The `yarn link` command will link the `index.js` file to the `pandoras-box` command, so it can be executed from
anywhere.
Local code can now be modified, and built again - changes made will be reflected on future command runs.

# Modes

## EOA

The `EOA` mode is pretty straightforward - it is a simple value transfer mode between regular Ethereum accounts.
This mode sends out transactions with a certain value transfer between subaccounts.

## ERC20

The `ERC20` mode deploys an ERC20 token to the blockchain network being tested before starting the cycle run.
When the cycle run begins, the transactions that are sent out are ERC20 token transfers between subaccounts.

## ERC721

The `ERC721` mode deploys an ERC721 NFT contract to the blockchain network being tested before starting the cycle run.
When the cycle run begins, the transactions that are sent out are ERC721 NFT mints.


Basic Transaction Stats:
┌──────────────┬─────────┐
│ Metric       │ Count   │
├──────────────┼─────────┤
│ Sent (Total) │ 1000    │
├──────────────┼─────────┤
│ L2 Success   │ 1000    │
├──────────────┼─────────┤
│ L1 Success   │ 1000    │
├──────────────┼─────────┤
│ Success Rate │ 100.00% │
└──────────────┴─────────┘

Delay Statistics (L2 → L1):
┌────────┬─────────┐
│ Metric │ Seconds │
├────────┼─────────┤
│ Max    │ 1658    │
├────────┼─────────┤
│ Min    │ 337     │
├────────┼─────────┤
│ Avg    │ 984.47  │
├────────┼─────────┤
│ Median │ 931     │
├────────┼─────────┤
│ P95    │ 1658    │
├────────┼─────────┤
│ P99    │ 1658    │
└────────┴─────────┘

L2 per-block stats:
┌───────┬─────┬───────┬────────┐
│ Block │ Txs │ Δt(s) │ TPS    │
├───────┼─────┼───────┼────────┤
│ 2835  │ 1   │ 3     │ 0.33   │
├───────┼─────┼───────┼────────┤
│ 2836  │ 180 │ 2     │ 90.00  │
├───────┼─────┼───────┼────────┤
│ 2837  │ 170 │ 1     │ 170.00 │
├───────┼─────┼───────┼────────┤
│ 2838  │ 204 │ 1     │ 204.00 │
├───────┼─────┼───────┼────────┤
│ 2839  │ 234 │ 1     │ 234.00 │
├───────┼─────┼───────┼────────┤
│ 2840  │ 211 │ 1     │ 211.00 │
└───────┴─────┴───────┴────────┘

L2 throughput:
┌───────┬──────────────┬─────────┬─────────┐
│ Layer │ Max Tx/Block │ Max TPS │ Avg TPS │
├───────┼──────────────┼─────────┼─────────┤
│ L2    │ 234          │ 234     │ 151.56  │
└───────┴──────────────┴─────────┴─────────┘

L1 per-block stats:
┌──────────┬─────┬───────┬────────┐
│ Block    │ Txs │ Δt(s) │ TPS    │
├──────────┼─────┼───────┼────────┤
│ 11617888 │ 85  │ 1.94  │ 43.84  │
├──────────┼─────┼───────┼────────┤
│ 11618031 │ 85  │ 0.69  │ 122.30 │
├──────────┼─────┼───────┼────────┤
│ 11618180 │ 85  │ 1.02  │ 83.09  │
├──────────┼─────┼───────┼────────┤
│ 11618272 │ 85  │ 0.73  │ 116.92 │
├──────────┼─────┼───────┼────────┤
│ 11618426 │ 85  │ 0.42  │ 203.84 │
├──────────┼─────┼───────┼────────┤
│ 11618591 │ 85  │ 0.26  │ 330.74 │
├──────────┼─────┼───────┼────────┤
│ 11618716 │ 85  │ 1.33  │ 63.96  │
├──────────┼─────┼───────┼────────┤
│ 11618895 │ 85  │ 0.53  │ 160.08 │
├──────────┼─────┼───────┼────────┤
│ 11619052 │ 85  │ 0.44  │ 193.18 │
├──────────┼─────┼───────┼────────┤
│ 11619240 │ 85  │ 1.86  │ 45.82  │
├──────────┼─────┼───────┼────────┤
│ 11619360 │ 85  │ 4.08  │ 20.81  │
├──────────┼─────┼───────┼────────┤
│ 11619486 │ 65  │ 3.23  │ 20.14  │
└──────────┴─────┴───────┴────────┘

L1 throughput:
┌───────┬──────────────┬───────────────────┬─────────┐
│ Layer │ Max Tx/Block │ Max TPS           │ Avg TPS │
├───────┼──────────────┼───────────────────┼─────────┤
│ L1    │ 85           │ 330.7393388846833 │ 117.06  │
└───────┴──────────────┴───────────────────┴─────────┘