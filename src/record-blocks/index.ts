import { hex2str } from '../common/utils.ts';
import { getRpcClient } from '../common/asyncUtils.ts';
import { addBlock, getBlockCounter, getBlockTransaction } from '../common/dbUtils.ts';

const idenaNodeUrl = 'https://restricted.idena.io';
const idenaNodeApiKey = 'idena-restricted-node-key';
const contractAddress = '0x8d318630eB62A032d2f8073d74f05cbF7c6C87Ae';
const makePostMethod = 'makePost';
const thisChannelId = '';
const LONG_RUNNING_LAMBDA = false;
const POLLING_INTERVAL_FAST = 10;
const POLLING_INTERVAL_SLOW = 2000;

const DEBUG = false;

if (!DEBUG) {
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
}

export const handler = async (event: any, context: any) => {
    const rpcClientRef = { current: getRpcClient({ idenaNodeUrl, idenaNodeApiKey }) };
    const currentBlockCapturedRef = { current: 0 };
    const previousBlockWithTxsRef = { current: 0 };

    const setCurrentBlockCaptured = async (currentBlock: number, previousBlockWithTxs: number, transactions: string[]) => {
        await addBlock(currentBlock, previousBlockWithTxs, transactions);
        console.log('block added:', currentBlock);
    };

    const blockCounter = await getBlockCounter();
    const { initial, last_captured, last_captured_with_txs } = blockCounter!;

    let initialBlock = initial > (last_captured + 1) ? initial : last_captured + 1;

    const blockTransaction = await getBlockTransaction(last_captured);

    previousBlockWithTxsRef.current = blockTransaction.transactions?.size ? last_captured : last_captured_with_txs;

    let recurseForwardIntervalId: NodeJS.Timeout;
    let consecutiveBlockFoundCount = 0;

    async function recurseForward(pollingInterval: number) {
        console.log('pollingInterval', pollingInterval);
        await new Promise((resolve: any) => {
            recurseForwardIntervalId = setTimeout(postScannerFactory(true, recurseForward, currentBlockCapturedRef, setCurrentBlockCaptured, resolve), pollingInterval);
        });
        clearInterval(recurseForwardIntervalId);
    };
    await recurseForward(POLLING_INTERVAL_SLOW);


    function postScannerFactory(recurseForward: boolean, recurse: any, blockCapturedRef: any, setBlockCaptured: any, resolve: any) {
        return async function postFinder() {
            try {
                const pendingBlock = recurseForward ? blockCapturedRef.current ? blockCapturedRef.current + 1 : initialBlock : blockCapturedRef.current ? blockCapturedRef.current - 1 : initialBlock - 1;

                // @ts-ignore
                const { result: getBlockByHeightResult } = await rpcClientRef.current('bcn_blockAt', [pendingBlock]);

                if (getBlockByHeightResult === null) {
                    throw 'no block';
                }
                
                if (getBlockByHeightResult.transactions === null) {
                    await setBlockCaptured(pendingBlock, previousBlockWithTxsRef.current, []);
                    currentBlockCapturedRef.current = pendingBlock;
                    throw 'block found - no transactions';
                }

                const transactions: string[] = [];

                for (let index = 0; index < getBlockByHeightResult.transactions.length; index++) {
                    const transaction = getBlockByHeightResult.transactions[index];

                    // @ts-ignore
                    const { result: getTxReceiptResult } = await rpcClientRef.current('bcn_txReceipt', [transaction]);

                    if (!getTxReceiptResult) {
                        continue;
                    }

                    if (getTxReceiptResult.contract !== contractAddress.toLowerCase()) {
                        continue;
                    }

                    if (getTxReceiptResult.method !== makePostMethod) {
                        continue;
                    }

                    if (getTxReceiptResult.success !== true) {
                        continue;
                    }

                    const channelId = hex2str(getTxReceiptResult.events[0].args[2]);
                    const message = hex2str(getTxReceiptResult.events[0].args[3]);

                    if (channelId !== thisChannelId) {
                        continue;
                    }

                    if (!message) {
                        continue;
                    }

                    transactions.unshift(transaction);
                }

                await setBlockCaptured(pendingBlock, previousBlockWithTxsRef.current, transactions);
                currentBlockCapturedRef.current = pendingBlock;

                if (transactions.length) {
                    previousBlockWithTxsRef.current = pendingBlock;
                }

                throw 'block found';

            } catch(error) {
                if (Math.abs(context.getRemainingTimeInMillis()) > 5000) {
                    if (typeof error === 'string' && error.startsWith('block found')) {
                        if (consecutiveBlockFoundCount < 5) {
                            consecutiveBlockFoundCount += 1;
                            await recurse(POLLING_INTERVAL_SLOW);
                        } else {
                            await recurse(POLLING_INTERVAL_FAST);
                        }
                    } else if (typeof error === 'string' && error.startsWith('no block')) {
                        if (LONG_RUNNING_LAMBDA) {
                            consecutiveBlockFoundCount = 0;
                            await recurse(POLLING_INTERVAL_SLOW);
                        }
                    }
                }
            }
            resolve();
        };
    };
};
