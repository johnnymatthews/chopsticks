import { Argv } from 'yargs'
import { BN, hexToU8a, u8aToHex } from '@polkadot/util'
import { Block, runTask, taskHandler } from '@acala-network/chopsticks-core'
import { HexString } from '@polkadot/util/types'
import { blake2AsHex } from '@polkadot/util-crypto'
import { writeFileSync } from 'fs'
import { z } from 'zod'

import { configSchema, getYargsOptions } from '../../schema/index.js'
import { overrideWasm } from '../../utils/override.js'
import { setupContext } from '../../context.js'

const schema = configSchema.extend({
  'eth-rpc': z.string({
    description: 'Ethereum RPC URL',
  }),
})

export const cli = (y: Argv) => {
  y.command(
    'trace-transaction <tx-hash>',
    'Trace a transaction',
    (yargs) =>
      yargs.options(getYargsOptions(schema.shape)).positional('tx-hash', {
        desc: 'Transaction hash',
        type: 'string',
      }),
    async (argv) => {
      const config = schema.parse(argv)
      const wasm = config['wasm-override']
      if (!wasm) {
        throw new Error('Wasm override built with feature `tracing` is required')
      }
      delete config['wasm-override']
      const context = await setupContext(config, false)
      const txHash = argv['tx-hash']

      const response = await fetch(config['eth-rpc'], {
        headers: [
          ['Content-Type', 'application/json'],
          ['Accept', 'application/json'],
        ],
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [txHash] }),
      })
      const data = await response.json()
      if (data.error) {
        throw new Error(data.error.message)
      }
      console.log({ transaction: data.result })
      const { from, to, value, gas, input, blockHash } = data.result

      const block = await context.chain.getBlock(blockHash)
      if (!block) {
        throw new Error(`Block not found ${blockHash}`)
      }
      const header = await block.header
      const meta = await block.meta
      const parent = await context.chain.getBlock(header.parentHash.toHex())
      if (!parent) {
        throw new Error(`Block not found ${blockHash}`)
      }
      await context.chain.setHead(parent)
      await overrideWasm(context.chain, wasm)
      const extrinsics = await block.extrinsics
      const txIndex = extrinsics.findIndex((tx) => blake2AsHex(tx) === txHash)

      const newBlock = new Block(context.chain, block.number, blockHash, parent, {
        header,
        extrinsics: [],
        storage: parent.storage,
      })

      meta.registry.register({
        Step: {
          op: 'String',
          pc: 'Compact<u64>',
          stack: 'Vec<H256>',
          memory: 'Vec<u8>',
        },
        CallType: {
          _enum: {
            CALL: null,
            CALLCODE: null,
            STATICCALL: null,
            DELEGATECALL: null,
            CREATE: null,
            SUICIDE: null,
          },
        },
        CallTrace: {
          type: 'CallType',
          from: 'H160',
          to: 'H160',
          input: 'Bytes',
          value: 'U256',
          gas: 'Compact<u64>',
          gasUsed: 'Compact<u64>',
          output: 'Option<Bytes>',
          error: 'Option<String>',
          revertReason: 'Option<String>',
          depth: 'Compact<u32>',
          calls: 'Vec<CallTrace>',
        },
      })

      const run = async (fn: string, args: HexString[]) => {
        const result = await runTask(
          {
            wasm: await block.wasm,
            calls: [[fn, args]],
            mockSignatureHost: false,
            allowUnresolvedImports: false,
            runtimeLogLevel: 0,
          },
          taskHandler(newBlock),
        )

        if ('Error' in result) {
          throw new Error(result.Error)
        }

        newBlock.pushStorageLayer().setAll(result.Call.storageDiff)
      }

      await run('Core_initialize_block', [header.toHex()])
      for (const extrinsic of extrinsics.slice(0, txIndex)) {
        await run('BlockBuilder_apply_extrinsic', [extrinsic])
      }

      const GAS_MASK = new BN(100000)
      const STORAGE_MASK = new BN(100)
      const GAS_LIMIT_CHUNK = new BN(30000)
      const MAX_GAS_LIMIT_CC = new BN(21) // log2(BLOCK_STORAGE_LIMIT)

      const bbbcc = new BN(Number(gas)).mod(GAS_MASK)
      const encodedGasLimit = bbbcc.div(STORAGE_MASK) // bbb
      const encodedStorageLimit = bbbcc.mod(STORAGE_MASK) // cc

      const gasLimit = encodedGasLimit.mul(GAS_LIMIT_CHUNK)
      const storageLimit = new BN(2).pow(
        encodedStorageLimit.gt(MAX_GAS_LIMIT_CC) ? MAX_GAS_LIMIT_CC : encodedStorageLimit,
      )

      const res = await newBlock.call('EVMRuntimeRPCApi_trace_call', [
        from,
        to,
        u8aToHex(meta.registry.createType('Vec<u8>', input).toU8a()),
        u8aToHex(meta.registry.createType('Balance', hexToU8a(value)).toU8a()),
        u8aToHex(meta.registry.createType('u64', gasLimit).toU8a()),
        u8aToHex(meta.registry.createType('u32', storageLimit).toU8a()),
        '0x00', // empty access list
      ])

      const logs = meta.registry.createType<any>('Result<Vec<CallTrace>, DispatchError>', res.result).asOk.toJSON()

      const filepath = `${process.cwd()}/trace-${txHash}.json`
      writeFileSync(filepath, JSON.stringify(logs, null, 2))
      console.log(`Trace file ${filepath}`)
      process.exit(0)
    },
  )
}
