#!/usr/bin/env node
import { Command } from 'commander';
import { JsonRpcProvider } from '@ethersproject/providers';
import { Distributor, Runtime } from './distributor/distributor';
import TokenDistributor from './distributor/tokenDistributor';
import Logger from './logger/logger';
import Outputter from './outputter/outputter';
import { Engine, EngineContext } from './runtime/engine';
import EOARuntime from './runtime/eoa';
import ERC20Runtime from './runtime/erc20';
import ERC721Runtime from './runtime/erc721';
import ClearPendingRuntime from './runtime/clearPendingRuntime';
import GetPendingCountRuntime from './runtime/getPendingCountRuntime';
import RuntimeErrors from './runtime/errors';
import {
    InitializedRuntime,
    RuntimeType,
    TokenRuntime,
} from './runtime/runtimes';
import { StatCollector } from './stats/collector';
import { parseUnits } from '@ethersproject/units'; // ADDED
import WithdrawalRuntime from './runtime/withdrawal';

async function run() {
    const program = new Command();

    program
        .name('pandoras-box')
        .description(
            'A small and simple stress testing tool for Ethereum-compatible blockchain clients '
        )
        .version('1.0.0');

    program
        .requiredOption(
            '-u, --json-rpc <json-rpc-address>',
            'The URL of the JSON-RPC for the client'
        )
        .option(
            '-m, --mnemonic <mnemonic>',
            'The mnemonic used to generate spam accounts'
        )
        .option(
            '-s, --sub-accounts <sub-accounts>',
            'The number of sub-accounts to use',
            '10'
        )
        .option(
            '-t, --transactions <transactions>',
            'The total number of transactions to be emitted',
            '2000'
        )
        .option(
            '--num-accounts <number>',
            'The number of accounts to use for CLEAR_PENDING mode',
            '1000'
        )
        .option(
            '--start-index <number>',
            'The starting account index for CLEAR_PENDING mode',
            '0'
        )
        .option(
            '--end-index <number>',
            'The ending account index for CLEAR_PENDING mode (exclusive)'
        )
        .option(
            '--fixed-gas-price',
            'Use a fixed gas price of 1 Gwei for EOA, ERC20, and ERC721 modes.',
            false
        )
        .option(
            '--mode <mode>',
            'The mode for the stress test. Possible modes: [EOA, ERC20, ERC721, CLEAR_PENDING, GET_PENDING_COUNT, WITHDRAWAL]',
            'EOA'
        )
        .option(
            '--moat-address <address>',
            'Moat contract address used in WITHDRAWAL mode'
        )
        .option(
            '--target-address <address>',
            'L1 target address for withdrawToL1 in WITHDRAWAL mode'
        )
        .option(
            '-o, --output <output-path>',
            'The output path for the results JSON'
        )
        .option(
            '-b, --batch <batch>',
            'The batch size of JSON-RPC transactions',
            '20'
        )
        .option(
            '-c, --concurrency <concurrency>',
            'The maximum number of concurrent batch requests'
        )
        .parse();

    const options = program.opts();

    const url = options.jsonRpc;
    let transactionCount = options.transactions;
    const mode = options.mode;
    const mnemonic = options.mnemonic;
    const subAccountsCount = options.subAccounts;
    const batchSize = options.batch;
    const output = options.output;
    const concurrency = options.concurrency;
    const numAccounts = parseInt(options.numAccounts, 10);
    const useFixedGasPrice = options.fixedGasPrice;
    const startIndex = parseInt(options.startIndex, 10);
    const endIndex = options.endIndex ? parseInt(options.endIndex, 10) : undefined;
    let fixedGasPrice = null;
    const moatAddress = options.moatAddress;
    const targetAddress = options.targetAddress || '0x000000000000000000000000000000000000dead';

    if (useFixedGasPrice) {
        fixedGasPrice = parseUnits('1', 'gwei');
        Logger.info(`Using fixed gas price of ${fixedGasPrice} for all transactions.`);
    }


    // Handle the GET_PENDING_COUNT mode as a standalone utility
    if (mode === RuntimeType.GET_PENDING_COUNT) {
        const getPendingCountRuntime = new GetPendingCountRuntime(url);
        await getPendingCountRuntime.run();
        return; // Exit after getting the count
    }

    if (mode === RuntimeType.CLEAR_PENDING) {
        if (!mnemonic) {
            Logger.error('Error: Mnemonic is required for CLEAR_PENDING mode. Please provide one with -m');
            return;
        }
        const clearPendingRuntime = new ClearPendingRuntime(url, mnemonic, numAccounts, concurrency, startIndex, endIndex);
        await clearPendingRuntime.run();
        return;
    }


    let runtime: Runtime;

    // Handle the CLEAR_PENDING mode (now implemented via EOA)
    if (!mnemonic) {
        Logger.error(`Error: Mnemonic is required for ${mode} mode. Please provide one with -m`);
        return;
    }

    switch (mode) {
        case RuntimeType.EOA:
            runtime = new EOARuntime(mnemonic, url, fixedGasPrice);
            break;
        case RuntimeType.ERC20:
            runtime = new ERC20Runtime(mnemonic, url, fixedGasPrice);
            Logger.info('\nDeploying ERC20 contract, this may take a moment...');
            await (runtime as InitializedRuntime).Initialize();
            Logger.success('ERC20 contract deployed successfully.');
            break;
        case RuntimeType.ERC721:
            runtime = new ERC721Runtime(mnemonic, url, fixedGasPrice);
            Logger.info('\nDeploying ERC721 contract, this may take a moment...');
            await (runtime as InitializedRuntime).Initialize();
            Logger.success('ERC721 contract deployed successfully.');
            break;
        case RuntimeType.WITHDRAWAL:
            if (!moatAddress) {
                Logger.error('Error: --moat-address is required for WITHDRAWAL mode.');
                return;
            }
            //targetAddress 是这种格式: nmNf4f5kyvCFrfyUBoQU3TKN3Dyc5kcMoH
            runtime = new WithdrawalRuntime(mnemonic, url, moatAddress, targetAddress, fixedGasPrice);
            break;
        default:
            throw RuntimeErrors.errUnknownRuntime;
    }

    // Distribute the native currency funds
    const distributor = new Distributor(
        mnemonic,
        subAccountsCount,
        transactionCount,
        runtime,
        url,
        concurrency
    );

    const accountIndexes: number[] = await distributor.distribute();

    // Distribute the token funds, if any
    if (mode === RuntimeType.ERC20) {
        const tokenDistributor = new TokenDistributor(
            mnemonic,
            accountIndexes,
            transactionCount,
            runtime as TokenRuntime,
            concurrency
        );

        // Start the distribution
        await tokenDistributor.distributeTokens();
    }


    // Get current block height
    const provider = new JsonRpcProvider(url);
    const currentBlock = await provider.getBlockNumber();
    let startBlock = currentBlock;

    // Run the specific runtime
    const txHashes = await Engine.Run(
        runtime,
        new EngineContext(
            accountIndexes,
            transactionCount,
            batchSize,
            mnemonic,
            url,
            concurrency
        )
    );

    // Collect the data
    const collectorData = await new StatCollector().generateStats(
        txHashes,
        mnemonic,
        url,
        batchSize,
        startBlock
    );

    // Output the data if needed
    if (output) {
        Outputter.outputData(collectorData, output);
    }
}

run()
    .then()
    .catch((err) => {
        Logger.error(err);
    });