import { getBlockCounter, getBlockTransaction } from "../common/dbUtils.ts";

export const handler = async (event: any, context: any) => {
    const { queryStringParameters } = event;

    const blockNumberInput = parseInt(queryStringParameters.blockNumber);

    if (queryStringParameters.blockNumber && !Number.isFinite(blockNumberInput)) {
        return { statusCode: 400, body: 'invalid blockNumber' };
    }

    const lastCapturedBlock = (await getBlockCounter())!.last_captured;

    const initialblockNumber = queryStringParameters?.blockNumber ? blockNumberInput <= lastCapturedBlock ? blockNumberInput : lastCapturedBlock : lastCapturedBlock;

    const blocksWithTxs = [];
    let blockNumberIterator = initialblockNumber;

    for (let index = 0; index < 100; index++) {
        const { previous_block_with_txs: previousBlockWithTxs, transactions } = await getBlockTransaction(blockNumberIterator);

        if (index === 0 && transactions?.size) {
            blocksWithTxs.push(blockNumberIterator);
        }

        if (previousBlockWithTxs === 0) {
            break;
        }

        blocksWithTxs.push(previousBlockWithTxs);
        blockNumberIterator = previousBlockWithTxs;
    };

    return { statusCode: 200, body: JSON.stringify({ initialblockNumber, blocksWithTxs }) };
};
