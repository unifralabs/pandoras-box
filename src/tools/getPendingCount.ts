
import { JsonRpcProvider } from '@ethersproject/providers';
import { Command } from 'commander';
import { StatCollector } from '../stats/collector';

async function run() {
    const program = new Command();

    program
        .requiredOption(
            '-u, --json-rpc <json-rpc-address>',
            'The URL of the JSON-RPC for the client'
        )
        .parse();

    const options = program.opts();
    const url = options.jsonRpc;

    const provider = new JsonRpcProvider(url);
    const collector = new StatCollector();

    const pendingTxCount = await collector.getPendingTransactionCount(provider);
    console.log('Pending tx count', pendingTxCount);
}

run();
