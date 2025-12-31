import { DynamoDBClient, TransactWriteItemsCommand, type Put, type TransactWriteItemsCommandInput, type Update } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, type GetCommandInput } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({ region: 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(client);

export const addBlock = async (currentBlock: number, previousBlockWithTxs: number, transactions: string[]) => {
  const putBlockTransactionsParams: Put = {
    TableName: process.env.BLOCK_TRANSACTIONS_TABLE,
    Item: {
      block_number: { 'N': currentBlock.toString() },
      previous_block_with_txs: { 'N': previousBlockWithTxs.toString() },
      ...(transactions.length && { transactions: { 'SS': transactions } }),
    },
  };
  const updateBlockCounterParams: Update = {
    TableName: process.env.BLOCK_COUNTER_TABLE,
    Key: { id: { 'S': 'id' } },
    UpdateExpression: `SET last_captured = :lastCaptured, last_captured_with_txs = :lastCapturedWithTxs`,
    ExpressionAttributeValues: {
      ':lastCaptured': { 'N': currentBlock.toString() },
      ':lastCapturedWithTxs': { 'N': previousBlockWithTxs.toString() },
    },
  };

  const params: TransactWriteItemsCommandInput = { TransactItems: [{ Put: putBlockTransactionsParams }, { Update: updateBlockCounterParams }] };

  try {
    await docClient.send(new TransactWriteItemsCommand(params));
  } catch (err) {
    console.error('Error addBlock:', err);
    throw 'dynamodb addBlock error';
  }
};

export type BlockCounter = { initial: number, last_captured: number, last_captured_with_txs: number };
export const getBlockCounter = async () => {
  const params: GetCommandInput = {
    TableName: process.env.BLOCK_COUNTER_TABLE,
    Key: { id: 'id' },
  };

  try {
    return (await docClient.send(new GetCommand(params))).Item as BlockCounter;
  } catch (err) {
    console.error('Error getBlockCounter:', err);
    throw 'dynamodb getBlockCounter error';
  }
};

export type BlockTransaction = { block_number: number, previous_block_with_txs: number, transactions: Set<string> };
export const getBlockTransaction = async (blockNumber: number) => {
  const params: GetCommandInput = {
    TableName: process.env.BLOCK_TRANSACTIONS_TABLE,
    Key: { block_number: blockNumber },
  };

  try {
    return (await docClient.send(new GetCommand(params))).Item || {} as BlockTransaction;
  } catch (err) {
    console.error('Error getBlockTransaction:', err);
    return {} as BlockTransaction;
  }
};
