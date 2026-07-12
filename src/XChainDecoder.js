/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Decoder - Decoder Class
 * 
 * This file handles starting the decoder and parsing blocks and transactions
 *
 ********************************************************************/

// Load required libraries
const util = require('./util')
const crypto = require('crypto');
const bs58check = require('bs58check')
const bitcoin = require('bitcoinjs-lib')
const { createHash } = require('crypto')
const Database = require('./db.js')
const ecc = require('tiny-secp256k1')
const BlockchainConnector = require('./BlockchainConnector')
const CryptoNetworks = require('./CryptoNetworks')
const XChainBlockDecoder = require('./XChainBlockDecoder')
const strictTextDecoder = new TextDecoder('utf-8', { fatal: true })
const lenientTextDecoder = new TextDecoder('utf-8')

//We need to init the ecc to parse taproot addresses from output scripts
bitcoin.initEccLib(ecc);

const CHECK_BLOCK_DELAY_MS = 1000 //1 second to continously ask for new block when all has been parsed
const BLOCKCHAIN_INFO_REFRESH_MS = 30000 //Re-poll the node tip at least this often during catch-up so reported lag stays accurate
const MEMPOOL_INTERVAL = 60000 //60 seconds between mempool checks
const MEMPOOL_BATCH_SIZE = 1000

const MAGIC_WORD = "XCHN"
const MAGIC_WORD_BUFFER = Buffer.from(MAGIC_WORD)
const P2SH_BUFFER = Buffer.from("p2sh")
const P2WSH_BUFFER = Buffer.from("p2wsh")

const SYNCED_THRESHOLD = 3 //Maximum blocks behind to be synced
// Soft-expired dispensers (marked, not deleted, so a reorg can restore them) are
// hard-purged once this many blocks deep, and a pure function of canonical height
// so every node purges identically. This MUST stay >= the deepest per-chain
// reorg-recovery window, or a row is deleted before a legal in-window reorg can
// restore it (deleteBlockByIndex then matches zero rows), permanently losing a
// money-bearing dispenser on the reorged node. The platform's deepest window is
// DOGE = 120 (xchain-utxo-tracker DEFAULT_UNDO_BLOCKS: BTC 12 / LTC 48 / DOGE 120);
// the previous flat 100 sat BELOW DOGE's window. Invariant: SAFE_DEPTH >=
// deepest undo window + margin. The +6 margin means a small undo-window re-tune
// cannot land exactly at the purge threshold; dispenserSafeDepth.test.js
// enforces the invariant with a conformance read of undo-blocks.js, so raising
// any chain's window past the margin fails the suite until this is bumped.
// Purging deeper is the conservative direction (rows are merely retained longer
// before hard-purge; expiry semantics and action evaluation are unchanged).
const DISPENSER_EXPIRE_SAFE_DEPTH = 126 // 120 (DOGE undo window) + 6 margin
const MIN_VERIFICATION_PROGRESS_TO_PARSE = 0.99 //How much progress the node need to have to start parsing

// Maximum compiled on-chain ACTION push, in bytes (measured before
// bitcoin.script.decompile strips the OP_PUSHDATA prefix (see compiledDataLength).
// This is the protocol arbiter for ACTION size: any tx whose compiled push
// exceeds this is dropped. Canonical source of truth + the encoder's matching
// guard: xchain-documentation/protocol/constants.js (MAX_ACTION_DATA_LENGTH) /
// xchain-encoder validator MAX_COMPILED_ACTION_DATA_LENGTH. Kept equal by the
// cross-service regression suite.
const MAX_ACTION_DATA_LENGTH = 8192

// Compiled size of a single script push once bitcoin.script.compile adds its
// length prefix: a direct push opcode for <=75 bytes, OP_PUSHDATA1 (+2) for
// <=255, or OP_PUSHDATA2 (+3) beyond that. Single source for measuring both
// push[0] (data) and push[1] (rawData) in parseTransaction; this formula is
// the protocol-arbiter side of the encoder's identical compiledPushSize
// (xchain-encoder/src/validator.js), and the compiledPushSizeConformance test
// pins both against bitcoin.script.compile byte-for-byte across the 75/255
// prefix boundaries. Do not fork this logic inline again.
function compiledPushSize(byteLength){
    if (byteLength <= 75)  return byteLength + 1   // direct push opcode
    if (byteLength <= 255) return byteLength + 2   // OP_PUSHDATA1
    return byteLength + 3                           // OP_PUSHDATA2
}

const VALID_ACTION_NAMES = new Set([
    'ADDRESS', 'AIRDROP', 'ANCHOR', 'ATTEST',
    'BATCH', 'BROADCAST', 'CALLBACK', 'COINPAY', 'COLLECT',
    'DELEGATE', 'DEPLOY', 'DEPOSIT', 'DESTROY', 'DISPENSER',
    'DIVIDEND', 'EXECUTE', 'FILE', 'ISSUE', 'LINK', 'LIST', 'MESSAGE', 'MINT',
    'NODEPROOF', 'ORDER', 'PRICE', 'SEND', 'SLASH', 'SLEEP', 'STAKE', 'SWAP',
    'SWEEP', 'UNSTAKE', 'VOTE', 'WITHDRAW'
])

// Short-form ACTION-name aliases. A spec-following client may encode any of
// these leading tokens (e.g. the BRC20/SRC20-compatible TRANSFER, or MSG for a
// shorter MESSAGE) and produce a valid on-chain payload. We expand the alias to
// its canonical name BEFORE the VALID_ACTION_NAMES gate and rewrite the stored
// payload to the canonical form, so the decoder DB never holds aliased names and
// every downstream consumer sees one spelling per action.
const ACTION_ALIASES = {
    'TRANSFER': 'SEND',
    'ADDR': 'ADDRESS',
    'DROP': 'AIRDROP',
    'CAST': 'BROADCAST',
    'MSG': 'MESSAGE'
}

// Canonicalize the ACTION name in a raw payload buffer, expanding a short-form
// alias to its canonical form. Single source for the alias-canonicalization
// tokenize+lookup logic shared by the confirmed-block and mempool decode
// paths (: those two sites had drifted into structurally different
// implementations -- string split/join vs byte splice -- that happened to
// agree only because every encoder-producible payload is valid UTF-8; do not
// fork this logic inline again, same rule as compiledPushSize above).
//
// Tokenizes on the FIRST 0x7C ('|') byte only, matching the on-chain wire
// format (ACTION|param|param|...). The name portion is lenient-decoded ONLY
// for the alias lookup (so invalid UTF-8 in the name cannot throw); every
// byte after the first pipe is returned verbatim, untouched -- callers that
// need a string (the confirmed-block path) decode the returned buffer
// themselves with their own strict/lenient fallback, so U+FFFD substitution
// for invalid UTF-8 in the payload is applied exactly once, at the same call
// site and under the same conditions as before this helper existed.
//
// Returns { buffer, rawActionName, actionName, isKnown }:
//   buffer        - payload with the name portion rewritten to the canonical
//                    ASCII spelling when it was a recognized alias; the
//                    original buffer reference, unmodified, otherwise
//                    (including when the name is unknown).
//   rawActionName - the lenient-decoded name exactly as it appeared on-chain
//                    (for logging).
//   actionName    - the alias-expanded name.
//   isKnown       - whether actionName is a member of VALID_ACTION_NAMES.
function canonicalizeActionPayload(buffer) {
    const pipeIndex = buffer.indexOf(0x7C) // '|'
    const nameEnd = pipeIndex === -1 ? buffer.length : pipeIndex
    const rawActionName = lenientTextDecoder.decode(buffer.subarray(0, nameEnd))
    const actionName = ACTION_ALIASES[rawActionName] ?? rawActionName
    const isKnown = VALID_ACTION_NAMES.has(actionName)
    const outBuffer = (isKnown && actionName !== rawActionName)
        ? Buffer.concat([Buffer.from(actionName, 'ascii'), buffer.subarray(nameEnd)])
        : buffer
    return { buffer: outBuffer, rawActionName, actionName, isKnown }
}

const DB_TRANSACTION_BLOCKS_QUANTITY = 1 //How many blocks need to be processed before inserting the data into the database
const LOG_BLOCK_INTERVAL = 1000 //During catch-up sync, only log progress every N blocks

// How many times a block is re-parsed after a transaction-level parse throw before
// the offending transaction is quarantined (skipped + PARSE_ERROR event). Retrying
// first means a transient blip can never make this instance skip a transaction that
// other decoder instances accept; only a tx that fails every attempt is quarantined,
// which is deterministic across instances running this code. Throws tagged
// rpcLookupFailure (node RPC trouble inside parseTransaction) never count toward
// this cap: an RPC outage is not a poison tx, so those retry the block indefinitely
// rather than quarantining content other instances accept.
const TX_PARSE_MAX_RETRIES = 3

// Probe whether bitcoinjs-lib's 64-bit reader tolerates a value > 2^53-1 (the BigInt-safe
// bufferutils patch) rather than throwing 'value out of range'. The decoder relies on this
// patch to decode a Dogecoin output > 2^53-1 sat (~90.07M DOGE) without wedging block
// decode; it ships via a Dockerfile COPY over node_modules, so a stock/unpatched
// node_modules (a Dockerfile regression, or a non-Docker run) would silently reintroduce
// the wedge. Reads a synthetic 2^53 uint64 (one past the stock reader's ceiling). The
// bufferutils module is injectable for testing. Returns false on any failure (fail-safe:
// an unrecognizable module reads as "patch not confirmed").
function bigIntBufferutilsActive(bufferutils){
    try {
        let bu = bufferutils || require('bitcoinjs-lib/src/bufferutils')
        if (!bu.BufferReader) return false
        new bu.BufferReader(Buffer.from([0, 0, 0, 0, 0, 0, 0x20, 0])).readUInt64()
        return true
    } catch(_){
        return false
    }
}

class XChainDecoder {
    constructor(network, dbUrl, dbPort, dbName, dbUser, dbPassword, nodeUrl, nodePort, nodeUser, nodePassword, auxPow, feeDestination) {
        this.network = CryptoNetworks.getBitcoinJsNetwork(network)

        // Net portion ('mainnet'|'testnet'|'regtest') of the "<fullname>-<network>"
        // key, for the boot-time consensus-pin verification in start(). The
        // getBitcoinJsNetwork call above already threw on an unknown key, so the
        // suffix is guaranteed to be a valid network name here.
        this.consensusNetwork = String(network).slice(String(network).lastIndexOf('-') + 1)

        // Native-coin protocol fee destination address for this coin+network. When set (not the
        // unset placeholder), the decoder also persists any output paying it to transaction_outputs
        // so the indexer can validate native-coin fee payments. Null/placeholder disables capture.
        this.feeDestination = (feeDestination && feeDestination !== 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')
            ? feeDestination
            : null

        this.connector = new BlockchainConnector(nodeUrl, nodePort, nodeUser, nodePassword)
        this.dbUrl = dbUrl
        this.dbPort = dbPort
        this.dbName = dbName
        this.dbUser = dbUser
        this.dbPassword = dbPassword
        this.startBlockIndex = CryptoNetworks.getFirstBlock(network)
        // Default EXPIRATION window (days) for v0 dispenser opens that omit the
        // EXPIRATION field; must match the indexer's default-expiration rule.
        this.expirationFeeDefaultDays = CryptoNetworks.getExpirationFeeDefaultDays(network)
        this.xchainBlockDecoder = new XChainBlockDecoder(network)
      
        this.db = null
        this.mempoolDb = null
        this.fm = null
      
        this.debugTime = {}
      
        this.synced = false

        this.lastProcessedBlockIndex = -1
        this.blockchainInfoLastBlock = -1
        // Timestamp (ms) of the most recent successful getBlockchainInfo() call.
        // Zero means the tip has never been fetched. Used by getSyncStatus() to
        // flag a frozen tip so callers can distinguish a genuine zero lag from an
        // outage where the cached tip stopped advancing.
        this.blockchainInfoLastRefreshAt = 0
        this.mempoolInterval = null
        this.mempoolBusy = false

        this.stopFlag = false

        // Force the AuxPoW-stripping fetch path on for Dogecoin regardless of the
        // AUX_POW env flag: DOGE blocks carry a merged-mining AuxPoW section between
        // the 80-byte header and the tx count, so the plain getBlock path would hand
        // that hex to the bitcoinjs parser and wedge/misparse at the first merged-mined
        // block. Mirrors the same coin-derived forcing in xchain-utxo-tracker
        // (XChainUtxoTracker.js: `coinFromNetwork(network) === 'DOGE' ? true : auxPow`)
        // so chain identity, not operator env, decides the branch.
        this.auxPow = String(network).toLowerCase().startsWith('dogecoin') ? true : auxPow

        this.rpcErrors = 0
        this.parseErrors = 0
    }
    
    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Default EXPIRATION for a v0 dispenser open that omits the field: block time
    // plus the configured default window in seconds. Keep in sync with
    // xchain-indexer/src/utility.js getDefaultExpiration so both views agree on
    // whether an EXPIRATION-less dispenser is open.
    getDefaultExpiration(blockTime){
        return Number(blockTime) + (this.expirationFeeDefaultDays * 86400)
    }

    markTime(timeName){
        this.debugTime[timeName] = Date.now()
    }
    
    logTime(timeName){
        let endTime = Date.now()
        let msTime = (endTime - this.debugTime[timeName])
                    
        console.log("Time('"+timeName+"'): "+(msTime)+"ms")
    }
    
    millisecondsToTimeString(ms){
        var milliseconds = Math.floor((ms % 1000) / 100),
        seconds = Math.floor((ms / 1000) % 60),
        minutes = Math.floor((ms / (1000 * 60)) % 60),
        hours = Math.floor((ms / (1000 * 60 * 60)) % 24),
        days = Math.floor((ms / (1000 * 60 * 60 * 24)) % 365);

        hours = (hours < 10) ? "0" + hours : hours;
        minutes = (minutes < 10) ? "0" + minutes : minutes;
        seconds = (seconds < 10) ? "0" + seconds : seconds;

        return days+"d"+ hours + "h" + minutes + "m" + seconds + "." + milliseconds+"s";
    }
    
    isSynced(){
        // A frozen tip during a node outage must not read as synced: the chain may
        // have advanced far past the last cached tip, so synced:true would be false-healthy.
        if (this.blockchainInfoLastRefreshAt > 0
            && (Date.now() - this.blockchainInfoLastRefreshAt) > 2 * BLOCKCHAIN_INFO_REFRESH_MS) {
            return false
        }
        return this.synced
    }

    getSyncStatus() {
        if (this.lastProcessedBlockIndex === -1) {
            return { last_processed_block: null, node_height: null, lag: null }
        }
        // A stale tip means: we have polled at least once but the last successful
        // getBlockchainInfo() was more than 2x the normal refresh interval ago,
        // i.e. at least two consecutive poll attempts have failed (node outage).
        // In that window blockchainInfoLastBlock is frozen, so a zero lag does not
        // mean caught-up; it means we cannot see how far the chain has advanced.
        const nodeHeightStale = this.blockchainInfoLastRefreshAt > 0
            && (Date.now() - this.blockchainInfoLastRefreshAt) > 2 * BLOCKCHAIN_INFO_REFRESH_MS

        const status = {
            last_processed_block: this.lastProcessedBlockIndex,
            node_height: this.blockchainInfoLastBlock,
            lag: this.blockchainInfoLastBlock - this.lastProcessedBlockIndex
        }
        if (nodeHeightStale) status.node_height_stale = true
        return status
    }
    
    stop(){
        this.stopFlag = true
    }
    
    //This function is used to decipher the data inside xchain transaction
    async removeObfuscation(data, txid){
        var decryptedData = null
        
        if (Buffer.isBuffer(data)){
        
            try {
                var cipherKey = txid.substr(0,16)
                var iv = txid.substr(16,16)
                
                var decipher = crypto.createDecipheriv('aes-128-ctr', cipherKey, iv);
                decryptedData = decipher.update(data) // + decipher.final()
                decryptedData = Buffer.concat([decryptedData, decipher.final()])
            } catch (err){
                if ((err.code != "ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH") && (err.code != "ERR_OSSL_BAD_DECRYPT")){
                    throw err
                }
                decryptedData = null
            }
        }
        return decryptedData
    }
    
    async parseRawTransaction(rawTransaction){
        // Parse via xchainBlockDecoder.transactionFromHex, not bitcoin.Transaction.fromHex:
        // the former strips the LTC MWEB marker+flag (0x08/0x09) that makes vanilla strict
        // parsing throw a deterministic UInt64 range error. See getSourceFromOutput.
        return await this.parseTransaction(this.xchainBlockDecoder.transactionFromHex(rawTransaction))
    }
    
    //Gets the address from the output specified by the transaction hash id and the output index
    async getSourceFromOutput(txId, outputIndex){
        let source = null
        let output = null
        let outputTransaction = null

        // A prevout lookup that FAILS is not a prevout that does not exist. Swallowing
        // the failure into source=null made this instance skip (or mis-source) a tx that
        // every healthy instance accepts, committing instance-dependent block contents.
        // Tag and rethrow instead: the block loop rolls the whole block back and retries,
        // so a block is only ever committed from fully-resolved lookups. The prevout of a
        // confirmed tx always exists on a txindex node, so an empty RPC result is a
        // lookup failure too, never "absent".
        try {
            //Obtaining the output
            let outputRawTransaction = await this.connector.getRawTransaction(txId)
            if (!outputRawTransaction){
                throw new Error(`empty getrawtransaction result for confirmed prevout tx ${txId}`)
            }
            // MUST parse through transactionFromHex (strips the LTC MWEB marker+flag), not
            // bitcoin.Transaction.fromHex. A funding/prevout tx on Litecoin can carry the
            // MWEB flag (0x08/0x09); vanilla strict parsing throws a deterministic UInt64
            // range error, which the catch below then mis-tags as rpcLookupFailure=true.
            // The block loop treats rpcLookupFailure as transient node trouble and retries
            // the block FOREVER, so a deterministic content-parse error would wedge every
            // LTC decoder instance permanently. transactionFromHex is the same parser the
            // block path uses; for BTC/DOGE and non-flagged txs it is a plain parse.
            outputTransaction = this.xchainBlockDecoder.transactionFromHex(outputRawTransaction)
        } catch (err){
            this.rpcErrors++
            console.error(`getSourceFromOutput: failed to fetch tx ${txId} (output ${outputIndex}): `, err)
            err.rpcLookupFailure = true
            throw err
        }
        // An out-of-range output index is deterministic content (the same on every
        // instance), so it may still resolve to a null source below.
        output = outputTransaction.outs[outputIndex]

        if (output != null){
            let script = output.script
            //Check if output is a P2SH or P2WSH data-carrying reveal output. If so,
            //the spent output's own address is the script (commit) address, not the
            //signer; walk back one hop to the commit tx's first input and take
            //THAT prev output's address (the funder/issuer). Without the P2WSH branch
            //the source of every P2WSH-encoded action resolved to the bech32 script
            //address (bcrt1q...), which holds no gas → spurious "insufficient funds (FEE)".
            let isP2sh = (
                (script.length == 23) //23 bytes for a standard p2sh
                && (script[0] == 0xa9) //OP_HASH160
                && (script[1] == 0x14) //PUSH 20 bytes
                && (script[23 - 1] == 0x87) //OP_EQUAL
            )
            let isP2wsh = (
                (script.length == 34) //34 bytes for a standard p2wsh
                && (script[0] == 0x00) //OP_0 (witness v0)
                && (script[1] == 0x20) //PUSH 32 bytes
            )
            if (isP2sh || isP2wsh){
                let prevOutputIndex = outputTransaction.ins[0].index
                let prevTxHash = util.uint8ArrayToHex(Buffer.from(outputTransaction.ins[0].hash).reverse())
                // Same fail-loud contract as the first fetch: tag the failure so the
                // block loop retries the block instead of quarantining the tx.
                let prevTransaction
                try {
                    let prevRawTransaction = await this.connector.getRawTransaction(prevTxHash)
                    if (!prevRawTransaction){
                        throw new Error(`empty getrawtransaction result for confirmed commit-funding tx ${prevTxHash}`)
                    }
                    // transactionFromHex (MWEB-flag-safe), not bitcoin.Transaction.fromHex; see above.
                    prevTransaction = this.xchainBlockDecoder.transactionFromHex(prevRawTransaction)
                } catch (err){
                    this.rpcErrors++
                    console.error(`getSourceFromOutput: failed to fetch commit-funding tx ${prevTxHash}: `, err)
                    err.rpcLookupFailure = true
                    throw err
                }
                output = prevTransaction.outs[prevOutputIndex]
            }
            
            
            try {
                if (!this.isFutureSegwitScript(output.script))
                    source = bitcoin.address.fromOutputScript(output.script, this.network)
            } catch(err){
                //Ignoring specific sources
                /*let decompiledScript = bitcoin.script.decompile(output.script)
                if ( //P2PK
                    (decompiledScript.length == 2)
                    &&(Buffer.isBuffer(decompiledScript[0]))
                    && (decompiledScript[0].length == 33)
                    && (decompiledScript[1] == bitcoin.opcodes.OP_CHECKSIG)
                ){
                    //Do nothing, null will be returned
                } else if ( //MULTISIG
                    (decompiledScript.length > 0)
                    && (decompiledScript[decompiledScript.length - 1] == bitcoin.opcodes.OP_CHECKMULTISIG)
                ){
                    //Do nothing, null will be returned
                } else {
                    throw err
                }*/
                
                //Bitcoinjs-lib didn't find a valid address, ignore it, null will be returned
            }
        }
        
        return source
    }
    
    extractPubkeyFromInput(input){
        // P2WPKH or P2SH-P2WPKH: pubkey is second witness element
        if (input.witness && input.witness.length >= 2){
            let pubkey = input.witness[1]
            if (pubkey && (pubkey.length === 33 || pubkey.length === 65)){
                return pubkey.toString('hex')
            }
        }
        // P2PKH: scriptSig is <sig> <pubkey>, decompile and take last element
        if (input.script && input.script.length > 0){
            let decompiledScript = bitcoin.script.decompile(input.script)
            if (decompiledScript && decompiledScript.length >= 2){
                let lastElement = decompiledScript[decompiledScript.length - 1]
                if (Buffer.isBuffer(lastElement) && (lastElement.length === 33 || lastElement.length === 65)){
                    return lastElement.toString('hex')
                }
            }
        }
        return null
    }

    isFutureSegwitScript(script) {
        // Native segwit scripts: version byte (OP_0..OP_16) + push length + witness program
        // Total length is 4-42 bytes.  OP_0 (v0) and OP_1 (v1/taproot) are handled by
        // bitcoinjs-lib; OP_2-OP_16 (0x52-0x60) are "future" versions that trigger a
        // console warning.  Must also verify the push-length byte matches, otherwise
        // non-segwit scripts like P2PKH (starts with OP_DUP=0x76) would be misclassified.
        if (script.length < 4 || script.length > 42) return false
        let version = script[0]
        if (version < 0x52 || version > 0x60) return false
        let pushLen = script[1]
        return pushLen >= 2 && pushLen <= 40 && script.length === pushLen + 2
    }

    // For a P2SH/P2WSH reveal, the native-coin fee output lives on the funding (commit) transaction:
    // the wallet/SDK place the fee output on the first tx they generate, and the reveal (this action's
    // tx) spends that commit's P2SH outputs. Fetch the funding tx and return any output paying the
    // protocol FEE_DESTINATION, shaped as a paymentOutput, so the indexer sees it among this action's
    // transaction_outputs and can validate the native-coin fee. Deterministic (same commit → same
    // output). Returns [] only for deterministic reasons (no fee destination configured, no funding
    // txid). A FAILED lookup throws (tagged rpcLookupFailure) so the block loop retries the block:
    // treating it as "no fee output" committed fee outputs on some instances and not others, and
    // whether an action paid its fee must never depend on which instance decoded it.
    async findFundingFeeOutputs(fundingTxId){
        let results = []
        if (!this.feeDestination || !fundingTxId) return results
        let fundingTx
        try {
            let fundingTxHex = await this.connector.getRawTransaction(fundingTxId)
            if (!fundingTxHex){
                throw new Error(`empty getrawtransaction result for confirmed funding tx ${fundingTxId}`)
            }
            // transactionFromHex (MWEB-flag-safe), not bitcoin.Transaction.fromHex; see getSourceFromOutput.
            fundingTx = this.xchainBlockDecoder.transactionFromHex(fundingTxHex)
        } catch (err){
            this.rpcErrors++
            console.error(`findFundingFeeOutputs: failed to fetch funding tx ${fundingTxId}:`, err.message)
            err.rpcLookupFailure = true
            throw err
        }
        for (let vout = 0; vout < fundingTx.outs.length; vout++){
            let output = fundingTx.outs[vout]
            let outputAddress = null
            try {
                if (!this.isFutureSegwitScript(output.script))
                    outputAddress = bitcoin.address.fromOutputScript(output.script, this.network)
            } catch (err){
                //the output script has no matching address; skip
            }
            if (outputAddress && outputAddress === this.feeDestination){
                results.push({ vout: vout, destinationAddress: outputAddress, amount: output.value })
            }
        }
        return results
    }

    async parseTransaction(transaction, openDispenserAddresses, db){
        // openDispenserAddresses is a Set of every open-dispenser address, loaded
        // once per block by the caller. Membership is tested in JS here instead of
        // issuing a DB round-trip per output. Defensive fallback to an empty Set
        // keeps callers that don't pass it (e.g. some unit tests) working.
        if (!openDispenserAddresses) openDispenserAddresses = new Set()
        // db is the handle used for the pubkey-capture writes below. The block path passes
        // this.db (default); the mempool path passes this.mempoolDb so pubkey writes for a
        // pending tx never touch the block's open transaction (M-19).
        if (!db) db = this.db
        // A zero-input transaction has no ins[0] to dereference below (the coinbase/
        // standard_input guard also reads ins[0]). An LTC MWEB/HogEx integration tx can
        // parse to zero canonical inputs after marker+flag stripping; such a tx carries no
        // XChain data. Skip it cleanly here, mirroring the mempool path's ins.length guard,
        // so it never throws a TypeError that costs 3 wasted block re-parses + a spurious
        // PARSE_ERROR quarantine event.
        if (!transaction.ins || transaction.ins.length === 0) return null
        let nextTxId = transaction.getId()
        let firstInputTxId = util.uint8ArrayToHex(Buffer.from(transaction.ins[0].hash).reverse())
        let standardInput = ("standard_input" in transaction.ins[0]?transaction.ins[0]["standard_input"]:true)
        let dispenseOutputs = []
        let paymentOutputs = []
        // For a P2SH/P2WSH reveal, the funding (commit) tx (whose outputs this reveal spends) is the
        // first input's previous tx. Native-coin fee outputs are placed there (not on the reveal), so we
        // capture the funding txid to look them up before returning. Null for non-P2SH transactions.
        let p2shFundingTxId = null

        //Ignore coin base transactions
        if ((firstInputTxId != "0000000000000000000000000000000000000000000000000000000000000000") && standardInput){
            let source = null
            let dataBuffer = Buffer.allocUnsafe(0)
            let rawData = null
            let getSource = false

            for (let txOutputIndex=0;txOutputIndex < transaction.outs.length;txOutputIndex++){
                let nextOutput = transaction.outs[txOutputIndex]
                let decompiledScript = bitcoin.script.decompile(nextOutput.script)
                let nextDataBuffer = new Buffer.allocUnsafe(0)

                let outputAddress = null
                try {
                    if (!this.isFutureSegwitScript(nextOutput.script))
                        outputAddress = bitcoin.address.fromOutputScript(nextOutput.script, this.network)
                } catch (err){
                    //the output script has no matching address
                }

                if (outputAddress){
                    let outputIsDispense = openDispenserAddresses.has(outputAddress)

                    if (outputIsDispense){
                        let dispenseOutput = {
                            txIndex:nextTxId,
                            vout:txOutputIndex,
                            destinationAddress:outputAddress,
                            amount:nextOutput.value
                        }

                        dispenseOutputs.push(dispenseOutput)
                        getSource = true
                    } else {
                        // Capture every non-OP_RETURN, non-dispense output. The indexer
                        // fans out per-output processing for payment actions (e.g. COINPAY)
                        // by LEFT JOIN-ing transaction_outputs and parsing once per row.
                        paymentOutputs.push({
                            vout:txOutputIndex,
                            destinationAddress:outputAddress,
                            amount:nextOutput.value
                        })
                    }
                }
                
                if ((decompiledScript != null) && (decompiledScript.length > 0)){
                    /*
                    * OP_RETURN
                    *
                    */
                    
                    if (
                        (decompiledScript.length == 2)
                        && (decompiledScript[0] == bitcoin.opcodes.OP_RETURN)
                    ){
                        //if (source == null){
                        //    source = await this.getSourceFromOutput(firstInputTxId, transaction.ins[0].index)
                        //}   
                        let dataWithoutObfuscation = await this.removeObfuscation(decompiledScript[1], firstInputTxId)
                        //let dataWithoutObfuscation = null
                        
                        if (dataWithoutObfuscation != null){
                            if (dataWithoutObfuscation.subarray(0, MAGIC_WORD.length).equals(MAGIC_WORD_BUFFER)){
                                /*
                                * P2SH
                                *
                                */
                                if (dataWithoutObfuscation.subarray(MAGIC_WORD.length).equals(P2SH_BUFFER)){
                                    p2shFundingTxId = firstInputTxId // commit tx carrying any native-coin fee output
                                    for (let txInputIndex=0;txInputIndex < transaction.ins.length;txInputIndex++){
                                        let nextInput = transaction.ins[txInputIndex]
                                        try {
                                            let decodedScriptSig = bitcoin.script.decompile(nextInput["script"])
                                            if (!decodedScriptSig || decodedScriptSig.length < 3 || !Buffer.isBuffer(decodedScriptSig[2])) continue
                                            let decodedRedeemScript = bitcoin.script.decompile(decodedScriptSig[2])
                                            if (!decodedRedeemScript || decodedRedeemScript.length < 1 || !Buffer.isBuffer(decodedRedeemScript[0])) continue
                                            let decodedData = decodedRedeemScript[0]
                                            nextDataBuffer = Buffer.concat([nextDataBuffer,decodedData])
                                        } catch (e) {
                                            this.parseErrors++
                                            console.error(`P2SH data extraction failed for input ${txInputIndex} of tx ${nextTxId}:`, e)
                                            // Do NOT drop this input's chunk and keep concatenating: a missing
                                            // interior chunk leaves nextDataBuffer holding a silently truncated
                                            // ACTION payload that can still decompile to a corrupted push, with no
                                            // quarantine event. Fail the whole tx instead so the block loop routes
                                            // it through the TX_PARSE_MAX_RETRIES retry-then-PARSE_ERROR quarantine
                                            // path (this file's fail-loud-or-quarantine contract).
                                            throw new Error(`P2SH data extraction failed for input ${txInputIndex} of tx ${nextTxId}: ${e && e.message ? e.message : e}`)
                                        }
                                    }

                                /*
                                * P2WSH
                                *
                                */
                                } else if (dataWithoutObfuscation.subarray(MAGIC_WORD.length).equals(P2WSH_BUFFER)){
                                    p2shFundingTxId = firstInputTxId // commit tx carrying any native-coin fee output
                                    for (let txInputIndex=0;txInputIndex < transaction.ins.length;txInputIndex++){
                                        let nextInput = transaction.ins[txInputIndex]
                                        try {
                                            if (!nextInput["witness"] || nextInput["witness"].length < 3 || !Buffer.isBuffer(nextInput["witness"][2])) continue
                                            let decodedRedeemScript = bitcoin.script.decompile(nextInput["witness"][2])
                                            if (!decodedRedeemScript || decodedRedeemScript.length < 1 || !Buffer.isBuffer(decodedRedeemScript[0])) continue
                                            let decodedData = decodedRedeemScript[0]
                                            nextDataBuffer = Buffer.concat([nextDataBuffer,decodedData])
                                        } catch (e) {
                                            this.parseErrors++
                                            console.error(`P2WSH data extraction failed for input ${txInputIndex} of tx ${nextTxId}:`, e)
                                            // Do NOT drop this input's chunk and keep concatenating: a missing
                                            // interior chunk leaves nextDataBuffer holding a silently truncated
                                            // ACTION payload that can still decompile to a corrupted push, with no
                                            // quarantine event. Fail the whole tx instead so the block loop routes
                                            // it through the TX_PARSE_MAX_RETRIES retry-then-PARSE_ERROR quarantine
                                            // path (this file's fail-loud-or-quarantine contract).
                                            throw new Error(`P2WSH data extraction failed for input ${txInputIndex} of tx ${nextTxId}: ${e && e.message ? e.message : e}`)
                                        }
                                    }
                                } else {
                                    nextDataBuffer = Buffer.concat([nextDataBuffer,dataWithoutObfuscation.subarray(MAGIC_WORD.length)])
                                }
                            }
                        }
                        
                    } else 
                    /*
                    * MULTISIGN
                    *
                    */              
                    
                    if (
                        (decompiledScript.length == 6)
                        && (decompiledScript[5] == bitcoin.opcodes.OP_CHECKMULTISIG)
                    ){
                        //if (source == null){
                        //    source = await this.getSourceFromOutput(firstInputTxId, transaction.ins[0].index)
                        //}
                        
                        if (!Buffer.isBuffer(decompiledScript[1]) || !Buffer.isBuffer(decompiledScript[2])) {
                            continue
                        }

                        let pubkey1 = decompiledScript[1].subarray(1) //removing the 02 at the beginning
                        let pubkey2 = decompiledScript[2].subarray(1) //removing the 02 at the beginning
                        //let pubkey3 = decompiledScript[3] //actual pubkey

                        let data = Buffer.concat([pubkey1, pubkey2])

                        // We intentionally do NOT strip trailing zero bytes here.
                        // The encoder's prepareData() zero-pads the plaintext chunk to fill
                        // the 64-byte MULTISIGN slot BEFORE obfuscation, so after decryption
                        // the trailing bytes are literal 0x00 (not keystream). The final
                        // partial chunk always carries this pad; a full 64-byte chunk also
                        // has a ~1/256 chance of a genuine 0x00 last ciphertext byte. Stripping
                        // either dropped a real byte, decrypted one byte short, and silently
                        // corrupted the payload (bitcoin.script.decompile returned null on the
                        // truncated buffer). Instead we decrypt the full chunk. The trailing
                        // 0x00 bytes fall outside the payload's own self-describing
                        // compiled-script length and are discarded when the reassembled buffer
                        // is run through bitcoin.script.decompile() below.
                        let dataWithoutObfuscation = await this.removeObfuscation(data, firstInputTxId)
                        
                        if (dataWithoutObfuscation != null){
                            if (dataWithoutObfuscation.subarray(0, MAGIC_WORD.length).equals(MAGIC_WORD_BUFFER)){
                                nextDataBuffer = Buffer.concat([nextDataBuffer,dataWithoutObfuscation.subarray(MAGIC_WORD.length)])
                            }
                        }
                    } 
                }

                if (nextDataBuffer.length > 0){
                    dataBuffer = Buffer.concat([dataBuffer,nextDataBuffer])
                }
            }
            
            // compiledDataLength starts as the raw accumulated byte count.
            // For P2SH/P2WSH/OP_RETURN this equals the compiled push size (the
            // script already carries the OP_PUSHDATA prefix). For MULTISIGN the
            // slots are zero-padded to 64 bytes each, so this value is inflated
            // by up to 59 bytes of pad on the final chunk. We re-measure below
            // once the decompile result is available.
            let compiledDataLength = dataBuffer.length

            if (dataBuffer.length > 0){
                let decompiledData = bitcoin.script.decompile(dataBuffer)
                if (decompiledData != null && decompiledData.length > 0) {
                    // A single-byte OP_0 segment ([0x00]) decompiles to the integer 0,
                    // not a Buffer, and a non-standard script can decompile to a leading
                    // opcode integer. On any non-Buffer result, reject the degenerate decode:
                    // clear dataBuffer and leave rawData/getSource untouched so a stray opcode
                    // integer can never reach the raw_data column or trigger a spurious source
                    // lookup. Every downstream consumer can then rely on dataBuffer being a
                    // Buffer (otherwise the integer silently fails .length guards and throws in
                    // hex-encoding paths). No valid payload is zero-length, so this is inert
                    // for real data.
                    if (!Buffer.isBuffer(decompiledData[0])){
                        dataBuffer = Buffer.allocUnsafe(0)
                    } else {
                        dataBuffer = decompiledData[0]
                        // Re-measure compiledDataLength from the decompiled buffer so MULTISIGN
                        // zero-pad inflation does not cause valid payloads in [8161, 8192] bytes
                        // to trip the MAX_ACTION_DATA_LENGTH guard. For P2SH/P2WSH/OP_RETURN the
                        // result is identical to the pre-decompile measurement: the push overhead
                        // (1 byte direct, 2 bytes OP_PUSHDATA1, 3 bytes OP_PUSHDATA2) is added
                        // back, matching exactly what the encoder's compiled script measured.
                        compiledDataLength = compiledPushSize(dataBuffer.length)
                        if (decompiledData.length > 1){
                            // Mirror the Buffer gate on decompiledData[0] above: decompile
                            // returns opcodes as integers, so a payload whose second element
                            // is an opcode (a trailing OP_1..OP_16/OP_1NEGATE, or the
                            // MULTISIGN zero-pad's OP_0) would otherwise flow a bare integer
                            // into rawData and the raw_data column, a shape no consumer
                            // expects (the encoder's push[1] is always a Buffer).
                            rawData = Buffer.isBuffer(decompiledData[1]) ? decompiledData[1] : null
                            // Count the second push too. The encoder bounds the WHOLE compiled
                            // script (both pushes) against MAX_COMPILED_ACTION_DATA_LENGTH, so
                            // measuring only push[0] here let a small action push + a large
                            // rawData push (e.g. a FILE) decode past the guard that the encoder
                            // and validator would have rejected. Add push[1]'s compiled size
                            // (data length + the same OP_PUSH overhead) so the decoder's ceiling
                            // matches the encoder's.
                            if (Buffer.isBuffer(rawData)){
                                compiledDataLength += compiledPushSize(rawData.length)
                            }
                        }
                        getSource = true
                    }
                } else {
                    dataBuffer = Buffer.allocUnsafe(0)
                }
            }
            
            //Get the source from the output spent by the first input of this transaction
            //only if there is data or a dispense and the source was not retrieved before
            if (getSource && (source == null)){
                source = await this.getSourceFromOutput(firstInputTxId, transaction.ins[0].index)
            }

            //Extract and store public key from the first input if source was found
            if (source){
                let pubkey = this.extractPubkeyFromInput(transaction.ins[0])
                if (pubkey){
                    let addressId = await db.getAddressId(source)
                    if (addressId && !(await db.hasPubkey(addressId))){
                        await db.insertPubkey(addressId, pubkey)
                    }
                }
            }

            //For a P2SH/P2WSH reveal, attribute the native-coin fee output (which lives on the funding
            //commit tx) to this action so the indexer can validate it (see findFundingFeeOutputs).
            if (p2shFundingTxId){
                let fundingFeeOutputs = await this.findFundingFeeOutputs(p2shFundingTxId)
                for (let feeOutput of fundingFeeOutputs){
                    paymentOutputs.push(feeOutput)
                }
            }

            return {
                data:dataBuffer,
                compiledDataLength: compiledDataLength,
                rawData: rawData,
                source:source,
                destination:null,
                dispenseOutputs:dispenseOutputs,
                paymentOutputs:paymentOutputs
            }
        } else {
            return null
        }
    }
    
    async verifyReorg(nodeTip){
        let thereAreDifferences = true
        let blocksDeleted = []
        let retryCount = 0

        // Restart-durable halt guard (item 1300). The safe-depth ceiling below is a
        // per-invocation counter over durably-committed per-block deletes: once it
        // fired the loud abort mid-rollback, nothing persisted the abort, so a plain
        // process restart re-entered here with a zeroed counter and silently completed
        // the over-deep rollback past the dispenser purge window (permanent, money-
        // bearing dispenser-state divergence). Every abort path now persists a durable
        // REORG_HALT marker (markReorgHalted); on entry we refuse to proceed while it
        // is set, so a restart cannot resume an over-deep rollback. Recovery is the
        // full resync the abort message demands (rebuilding the schema clears it).
        // Feature-detected so the minimal-mock verifyReorg tests stay unaffected.
        if (typeof this.db.isReorgHalted === 'function' && await this.db.isReorgHalted()){
            const msg = "verifyReorg: decoder is HALTED from a prior over-deep reorg abort. Refusing to "
                + "roll back further: a restart must not silently resume a rollback past the dispenser "
                + "safe-depth window (DISPENSER_EXPIRE_SAFE_DEPTH=" + DISPENSER_EXPIRE_SAFE_DEPTH + "), which "
                + "would permanently lose money-bearing dispenser state. Recovery: perform a full resync "
                + "from a known-good snapshot."
            console.error(msg)
            throw new Error(msg)
        }

        // Persist the durable halt marker before an abort throws (best-effort: swallow
        // write errors so a marker failure never masks the loud abort). Feature-detected.
        const haltReorg = async (reason) => {
            if (typeof this.db.markReorgHalted !== 'function') return
            try {
                await this.db.markReorgHalted(reason)
            } catch (e) {
                console.error('verifyReorg: failed to persist REORG_HALT marker:', e)
            }
        }

        // Fail-closed reorg-depth ceiling (parity with xchain-utxo-tracker's
        // UNDO_BLOCKS guard, XChainUtxoTracker.js verifyReorg). Soft-expired
        // dispensers are hard-purged once DISPENSER_EXPIRE_SAFE_DEPTH blocks
        // deep (purgeExpiredDispensers), and deleteBlockByIndex can only
        // resurrect a dispenser whose expired_block_index row still exists, so
        // rolling back past that window would silently and permanently lose
        // money-bearing dispenser state vs a from-scratch sync. A loud abort is
        // strictly safer than a silently corrupt DB: stop and require an
        // operator-driven resync. Called BEFORE each delete attempt (outside
        // the per-block retry try/catch, so the throw is not retried away).
        const assertWithinSafeDepth = async (lastBlockIndex) => {
            if (blocksDeleted.length >= DISPENSER_EXPIRE_SAFE_DEPTH){
                const msg = "verifyReorg: reorg depth exceeds the dispenser safe-depth window "
                    + "(DISPENSER_EXPIRE_SAFE_DEPTH=" + DISPENSER_EXPIRE_SAFE_DEPTH + "). Already rolled back "
                    + blocksDeleted.length + " blocks; soft-expired dispenser rows for block height "
                    + lastBlockIndex + " and below have already been hard-purged, so continuing would "
                    + "silently lose money-bearing dispenser state. Aborting. Recovery: perform a full "
                    + "resync from a known-good snapshot."
                console.error(msg)
                await haltReorg(msg)
                throw new Error(msg)
            }
        }

        while (thereAreDifferences){
            let lastBlockIndex = await this.db.getLastBlockIndex()
            let lastBlock = await this.db.getBlockByIndex(lastBlockIndex)

            // Stop the backward walk once the table is exhausted (getLastBlockIndex
            // returns -1 on an empty table, so getBlockByIndex(-1) yields null) or once
            // we have retreated past the configured start height. Without this guard a
            // deep reorg that invalidates every processed block would dereference a null
            // lastBlock below and crash before the REORG event is written, leaving the
            // decoder in an inconsistent restart state.
            if (!lastBlock || lastBlockIndex < this.startBlockIndex){
                thereAreDifferences = false
                break
            }

            // Blocks stored ABOVE the node's current tip are orphans the node no
            // longer has (deep reorg, node rollback, or restart onto a shorter chain).
            // getBlockHash(lastBlockIndex) would throw "Block height out of range",
            // and the transient-error catch below would retry it forever instead of
            // deleting it. Detect this with a deterministic height compare against
            // the tip passed in (no brittle RPC-error-string matching). nodeTip is
            // undefined for legacy callers (e.g. existing verifyReorg-only tests);
            // guard with != null so their behaviour is unchanged. The live parse loop
            // always passes the freshly-refreshed tip.
            if (nodeTip != null && lastBlockIndex > nodeTip){
                await assertWithinSafeDepth(lastBlockIndex)
                try {
                    // Pass the block hash so the delete and its REORG audit marker commit
                    // atomically (M-12); see deleteBlockByIndex for the durability rationale.
                    await this.db.deleteBlockByIndex(lastBlockIndex, lastBlock["block_hash"])
                    retryCount = 0
                    blocksDeleted.push({"block_index":lastBlockIndex, "block_hash":lastBlock["block_hash"]})
                } catch (err){
                    console.error(`reorg: failed to delete above-tip block ${lastBlockIndex} (${lastBlock.block_hash}): `, err)
                    if (++retryCount >= 10){ await haltReorg('verifyReorg: deleteBlockByIndex failed after 10 attempts (above-tip branch)'); throw new Error('verifyReorg: deleteBlockByIndex failed after 10 attempts, aborting') }
                    await this.sleep(3000)
                }
                continue
            }

            let blockHashFromNode
            try {
                blockHashFromNode = await this.connector.getBlockHash(lastBlockIndex)
            } catch (err){
                console.log("There was a problem trying to get a block hash from the node. Trying again...", err)
                // The node's tip may have regressed below lastBlockIndex mid-walk (node
                // restart onto a shorter chain, or a second reorg). Against the frozen
                // call-time nodeTip that makes getBlockHash(lastBlockIndex) throw "Block
                // height out of range" on every retry, wedging this walk forever (item
                // 1301). Best-effort re-read the tip so the above-tip delete branch can
                // classify and delete this now-orphaned height on the next pass. If the
                // node is fully unreachable this refresh also fails and we keep the
                // existing sleep-and-retry outage tolerance (retry-forever) unchanged.
                try {
                    const info = await this.connector.getBlockchainInfo()
                    if (info && typeof info.blocks === 'number') nodeTip = info.blocks
                } catch (refreshErr) { /* node unreachable; retry with the existing tip */ }
                await this.sleep(3000)
                continue
            }

            if (lastBlock["block_hash"] != blockHashFromNode){
                await assertWithinSafeDepth(lastBlockIndex)
                try {
                    // Pass the block hash so the delete and its REORG audit marker commit
                    // atomically (M-12); see deleteBlockByIndex for the durability rationale.
                    await this.db.deleteBlockByIndex(lastBlockIndex, lastBlock["block_hash"])

                    // Per-block retry budget: reset after each successful delete so the
                    // 10-attempt limit applies per block, not cumulatively across the whole
                    // reorg run. Otherwise a multi-block reorg with one transient failure per
                    // block could exhaust the budget and abort, leaving orphan blocks behind.
                    retryCount = 0
                    blocksDeleted.push({"block_index":lastBlockIndex, "block_hash":lastBlock["block_hash"]})
                } catch (err){
                    console.error(`reorg: failed to delete block ${lastBlockIndex} (${lastBlock.block_hash}): `, err)
                    if (++retryCount >= 10){ await haltReorg('verifyReorg: deleteBlockByIndex failed after 10 attempts (hash-compare branch)'); throw new Error('verifyReorg: deleteBlockByIndex failed after 10 attempts, aborting') }
                    await this.sleep(3000); continue
                }
            } else {
                thereAreDifferences = false
            }
        }
        
        if (blocksDeleted.length > 0){
            // Each rolled-back block already persisted its own REORG marker atomically with its
            // delete (deleteBlockByIndex, M-12), so there is no separate end-of-run event to write.
            // This is only an ops summary of the completed reorg.
            console.log(`reorg: rolled back ${blocksDeleted.length} block(s): ` + JSON.stringify(blocksDeleted.map(b => b.block_index)))
        }

        return true
    }
    
    async start(){
        // Verify the bundled canonical coin files against CONSENSUS_CONFIG_PIN
        // before touching the DB or processing any block, mirroring the indexer
        // (XChainIndexer.js:218). A null pin (mainnet, pre-arm) skips; a mismatch
        // on an armed network throws and halts startup, so a partial/stale deploy
        // cannot parse on-chain bytes with divergent network params (fail-closed,
        // deliberately not wrapped in try/catch).
        require('./coins').verifyConsensusPin(this.consensusNetwork)

        if (!this.db) {
            this.db = new Database(this.dbUrl, this.dbPort, this.dbName, this.dbUser, this.dbPassword)
        }

        // Dedicated DB handle for mempool maintenance (M-19). updateMempool runs on a 60s
        // timer that fires during the block loop's awaits, while the block loop holds an open
        // per-block transaction on this.db. Every db method resolves its connection via
        // getConnection(), which returns the shared transactionConnection whenever one is open,
        // so routing mempool work through this.db made its DELETE/INSERT land inside the live
        // block transaction, and a failed mempool insert called endTransaction() and rolled the
        // whole block back mid-parse. A separate Database instance never opens a block
        // transaction, so its getConnection() always draws an independent autocommit connection
        // from its own pool: mempool writes commit on their own and a mempool failure can neither
        // roll back nor block the block loop. Points at the same database (tables already created
        // by this.db); it only needs a live pool, so no createDatabase/verifyTables here.
        if (!this.mempoolDb) {
            this.mempoolDb = new Database(this.dbUrl, this.dbPort, this.dbName, this.dbUser, this.dbPassword)
        }

        // Only Dogecoin can carry a single output > 2^53-1 sat (~90.07M DOGE); BTC/LTC caps
        // are lower. If this is a DOGE decoder and the BigInt-safe bufferutils patch is NOT
        // active, the first such output throws during block decode and wedges the decoder
        // permanently (a silent Dockerfile-COPY regression). Shout at startup so that
        // regression is loud and immediate rather than a mid-operation fleet halt.
        if (this.xchainBlockDecoder && this.xchainBlockDecoder.coin === 'dogecoin' && !bigIntBufferutilsActive()){
            console.error('CRITICAL: bitcoinjs-lib bufferutils BigInt-safe 64-bit reader is NOT active on a ' +
                'Dogecoin decoder. A DOGE output > 2^53-1 sat (~90.07M DOGE) will throw during block decode ' +
                'and wedge this decoder permanently. Apply the bufferutils patch (Dockerfile COPY of ' +
                'src/bufferutils.js over node_modules/bitcoinjs-lib/src/bufferutils.js) before running on mainnet.')
        }

        // Verify the Decoder database exists
        let dbStatus   = await this.db.createDatabase();
        let dbVerified = await this.db.verifyDatabase();
        if(!dbVerified){
            util.throwError("Database " + this.dbName + " doesn't exist!");
        } else {
            // Verify the Indexer tables exists
            let tablesVerified = await this.db.verifyTables();
            if(!tablesVerified)
                util.throwError("Database " + this.dbName + " tables don't exist!");

            // Apply any pending `auto` schema migrations (additive/idempotent changes the
            // drift reconciler can't make on its own). Manual/destructive migrations stay
            // gated for an explicit operator run (`node src/migrate.js`). Recorded in the
            // schema_migrations ledger, so this is a no-op once applied.
            await this.db.runMigrations();
        }
    
        console.log("Parsing...")
        
        let lastProcessedBlockIndex = this.lastProcessedBlockIndex = await this.db.getLastBlockIndex()
        let lastProcessedTxIndex = await this.db.getLastTxIndex()

        if (lastProcessedBlockIndex < this.startBlockIndex - 1){
            lastProcessedBlockIndex = this.lastProcessedBlockIndex = this.startBlockIndex - 1
        }
        
        let lastBlockchainInfo = null
        let lastBlockchainInfoRefreshAt = 0
        // Tracks which blockchain-info refresh cycle the equal-height tip-hash
        // check last ran on, so it fires at most once per refresh (not every
        // 1-second sleep tick) to avoid a constant RPC + DB round-trip.
        let tipHashCheckedAt = 0
        this.blockchainInfoLastBlock = -1
        let blocksQuantity = 0
        
        let startTimeStamp = Date.now()
        
        let blocksCount = 0
        let transactionsCount = 0
        let validTransactionsCount = 0
        let outputCount = 0
        
        
        let nodeSyncedProblem = false

        // Transaction-level parse-failure tracking for the block currently being
        // retried (see TX_PARSE_MAX_RETRIES).
        let txParseRetryHeight = -1
        let txParseRetryCount = 0

        // Deterministic-INSERT-failure tracking. A row the DB rejects deterministically
        // (Database.POISON_ROW, e.g. a 4-byte-UTF-8 char on the utf8mb3 `data` column,
        // errno 1366) can never insert as-is, so retrying the block would wedge it forever.
        // After TX_PARSE_MAX_RETRIES the tx position is added to insertQuarantine and the
        // re-parse skips it (PARSE_ERROR + no insert), mirroring the parse-throw quarantine.
        // Keyed "<blockHeight>:<txPosition>"; cleared on block commit so it stays bounded
        // and cannot leak across a height whose content changed under a reorg. Only
        // DETERMINISTIC failures quarantine; transient ones (false) still retry forever, so
        // no instance ever skips a tx a healthy instance accepts (cross-instance parity).
        let insertQuarantineHeight = -1
        let insertQuarantineCount = 0
        const insertQuarantine = new Set()

        // Re-derive the loop cursors from the DB after any mid-block rollback, then
        // pause before the retry. Every rollback path MUST run this before continuing:
        // in particular lastProcessedTxIndex advances in memory while a block is being
        // parsed, so retrying a rolled-back block with the stale counter would assign
        // different tx_index values than a clean instance decoding the same block
        // (replicated content, so that is a cross-instance divergence, not cosmetics).
        const resetAfterRollback = async () => {
            lastProcessedBlockIndex = this.lastProcessedBlockIndex = Math.max(await this.db.getLastBlockIndex(), this.startBlockIndex - 1)
            lastProcessedTxIndex = await this.db.getLastTxIndex()
            blocksQuantity = 0
            await this.sleep(3000)
        }

        main_parsing:
        while (true){
            if (this.stopFlag){
                if (this.mempoolInterval != null){
                    console.log("Mempool updates stopped!")
                    clearInterval(this.mempoolInterval)
                    this.mempoolInterval = null
                }   
                break
            }
            
            //Getting network info to retrieve the last block index.
            //Refresh when we have no info yet, when we have caught up to the
            //previously-seen tip, OR periodically on a wall-clock interval; the
            //last condition keeps blockchainInfoLastBlock tracking the live chain
            //during a long catch-up, so the reported lag reflects the true remaining
            //gap instead of converging to zero against a frozen tip.
            if (!lastBlockchainInfo
                || (lastProcessedBlockIndex >= this.blockchainInfoLastBlock)
                || (Date.now() - lastBlockchainInfoRefreshAt >= BLOCKCHAIN_INFO_REFRESH_MS)){
                try {
                    lastBlockchainInfo = await this.connector.getBlockchainInfo()
                    
                    if (lastBlockchainInfo["verificationprogress"] < MIN_VERIFICATION_PROGRESS_TO_PARSE){
                        if (!nodeSyncedProblem){
                            console.log("The node is not synced. Waiting for it to synchronize...")
                        }
                        
                        lastBlockchainInfo = null
                        nodeSyncedProblem = true
                        await this.sleep(3000)
                        continue
                    } else {
                        nodeSyncedProblem = false
                    }
                    
                    this.blockchainInfoLastBlock = lastBlockchainInfo["blocks"]
                    lastBlockchainInfoRefreshAt = Date.now()
                    this.blockchainInfoLastRefreshAt = lastBlockchainInfoRefreshAt
                } catch (e){
                    console.log(e)
                    console.log("Error trying to get network info from the node. Trying again...", e)
                    await this.sleep(3000)
                    continue
                }
                
                if (lastProcessedBlockIndex > this.blockchainInfoLastBlock){
                    if (lastProcessedBlockIndex == this.startBlockIndex - 1){
                        // Benign: we have processed nothing yet and the node simply
                        // hasn't reached our configured start height. Wait, don't reorg.
                        console.log("Last block from the node ("+this.blockchainInfoLastBlock+") is still behind the starting block ("+this.startBlockIndex+")")
                        await this.sleep(5000)
                        continue
                    }

                    // The node's tip has dropped BELOW our last-processed height (deep
                    // reorg, node rollback, or restart onto a shorter/different chain).
                    // The forward hash-compare reorg path (below) is unreachable in this
                    // state (it only fires when fetching a block ABOVE our height), so
                    // without this branch the decoder loops forever logging the gap while
                    // orphan blocks above the node tip survive, which the indexer then
                    // inherits (the P0 failure TP-17 exists to prevent). Reconcile now:
                    // verifyReorg(tip) deletes every stored block above the tip via a
                    // deterministic height compare, then walks the hash-compare back to
                    // the fork point. blockchainInfoLastBlock was just refreshed above, so
                    // the tip is current.
                    console.log("The last processed block height ("+lastProcessedBlockIndex+") is greater than the last block from the node ("+this.blockchainInfoLastBlock+"). Reconciling orphan blocks...")
                    await this.db.endTransaction()
                    await this.verifyReorg(this.blockchainInfoLastBlock)
                    // Re-clamp: a deep reorg can empty the blocks table, causing
                    // getLastBlockIndex() to return -1 and nextBlockHeight to become 0
                    // on a nonzero-start network. Clamp here, the same as the pre-loop guard.
                    lastProcessedBlockIndex = this.lastProcessedBlockIndex = Math.max(await this.db.getLastBlockIndex(), this.startBlockIndex - 1)
                    lastProcessedTxIndex = await this.db.getLastTxIndex()
                    blocksQuantity = 0
                    transactionsCount = 0
                    validTransactionsCount = 0
                    outputCount = 0
                    startTimeStamp = Date.now()
                    console.log("Blocks were updated after node-tip regression")
                    continue
                }
            }
            
            //If there is no new block, wait for some seconds to ask again
            if (lastProcessedBlockIndex == this.blockchainInfoLastBlock){
                this.synced = true
                if (this.mempoolInterval == null){
                    console.log("Mempool parsing started!")
                    this.updateMempool().catch(err => console.error('[updateMempool] unhandled error:', err))
                    this.mempoolInterval = setInterval(() => {
                        this.updateMempool().catch(err => console.error('[updateMempool] unhandled error:', err))
                    }, MEMPOOL_INTERVAL)
                }

                // Equal-height tip-replacement check: if the node swapped its tip
                // for a different block at the same height (rare but possible), the
                // forward hash-compare below never fires until the NEXT block arrives.
                // Compare the node's current tip hash against the stored one on each
                // blockchain-info refresh (throttled so we add at most one RPC + one
                // DB query per 30-second refresh cycle, not every 1-second sleep tick).
                if (lastBlockchainInfoRefreshAt > tipHashCheckedAt && lastProcessedBlockIndex >= this.startBlockIndex){
                    tipHashCheckedAt = lastBlockchainInfoRefreshAt
                    try {
                        const nodeHash = await this.connector.getBlockHash(lastProcessedBlockIndex)
                        const storedBlock = await this.db.getBlockByIndex(lastProcessedBlockIndex)
                        if (storedBlock && nodeHash && storedBlock.block_hash !== nodeHash){
                            console.log("Equal-height tip replacement detected at height " + lastProcessedBlockIndex + ". Reconciling...")
                            await this.db.endTransaction()
                            await this.verifyReorg(this.blockchainInfoLastBlock)
                            lastProcessedBlockIndex = this.lastProcessedBlockIndex = Math.max(await this.db.getLastBlockIndex(), this.startBlockIndex - 1)
                            lastProcessedTxIndex = await this.db.getLastTxIndex()
                            blocksQuantity = 0
                            continue
                        }
                    } catch (e){
                        console.error('Error during equal-height tip-hash check, skipping:', e)
                    }
                }

                await this.sleep(CHECK_BLOCK_DELAY_MS)
            } else { //If there is a new block, parse it
                //Put the flag synced false if there are too many blocks behind
                if ((this.blockchainInfoLastBlock - lastProcessedBlockIndex) > SYNCED_THRESHOLD){
                    this.synced = false
                    if (this.mempoolInterval != null){
                        console.log("Mempool updates stopped!")
                        clearInterval(this.mempoolInterval)
                        this.mempoolInterval = null
                    }   
                }
                
                //Getting the raw block
                let nextBlockHeight = lastProcessedBlockIndex + 1
            
                let nextBlockHash = null
                let nextBlockHex = null
                // Track consecutive fetch failures at this exact height. A transient
                // RPC hiccup clears on the next success; a deterministic failure (e.g.
                // a malformed AuxPoW section that makes getBlockWithoutAuxPow throw)
                // would otherwise retry here silently forever. We never skip the block
                // (that would corrupt the index), but after a few attempts we escalate
                // to parseErrors so the stall is visible to the same monitoring that
                // watches the block-decode path below, rather than spinning unnoticed.
                if (this._fetchErrorHeight !== nextBlockHeight) {
                    this._fetchErrorHeight = nextBlockHeight
                    this._fetchErrorCount = 0
                }
                try {
                    nextBlockHash = await this.connector.getBlockHash(nextBlockHeight)

                    if (this.auxPow) {
                        nextBlockHex = await this.connector.getBlockWithoutAuxPow(nextBlockHash)
                    } else {
                        nextBlockHex = await this.connector.getBlock(nextBlockHash)
                    }
                    this._fetchErrorCount = 0
                } catch (e){
                    this._fetchErrorCount++
                    if (this._fetchErrorCount === 5) {
                        this.parseErrors++
                    }
                    console.error('Error fetching block at height ' + nextBlockHeight + ' (attempt ' + this._fetchErrorCount + '):', e)
                    await this.sleep(3000)
                    continue
                }
                
                // A throw here would otherwise escape start() and permanently stop the
                // decode loop (api.js only logs the rejection), wedging the pipeline at
                // this height. Never skip a whole block: a block we cannot decode is a
                // parser bug, not data to discard. Stay alive and keep retrying so
                // the process remains visible to health checks and recovers if the
                // failure was transient (e.g. corrupted RPC response).
                var block = null
                let previousBlockHash = null
                try {
                    block = this.xchainBlockDecoder.blockFromHex(nextBlockHex)
                    previousBlockHash = util.uint8ArrayToHex(Buffer.from(block.prevHash).reverse())
                } catch (e){
                    this.parseErrors++
                    console.error(`Failed to decode block ${nextBlockHeight} (${nextBlockHash}), retrying:`, e)
                    await this.db.endTransaction()
                    lastProcessedBlockIndex = this.lastProcessedBlockIndex = Math.max(await this.db.getLastBlockIndex(), this.startBlockIndex - 1)
                    lastProcessedTxIndex = await this.db.getLastTxIndex()
                    blocksQuantity = 0
                    await this.sleep(3000)
                    continue
                }

                //verify if there is an reorg
                if (nextBlockHeight > this.startBlockIndex){
                    let previousBlock = await this.db.getBlockByIndex(nextBlockHeight - 1)

                    // getBlockByIndex returns null both for a genuinely-missing row and
                    // for a caught DB error. A null here previously dereferenced straight
                    // into `previousBlock.block_hash` (TypeError), escaped start(), and
                    // permanently stopped the parse loop (api.js only logs the rejection).
                    // Treat null as transient and retry this height, matching the
                    // block-fetch error path above.
                    if (!previousBlock){
                        console.error(`Could not load previous block ${nextBlockHeight - 1} for reorg check, retrying...`)
                        await this.sleep(3000)
                        continue
                    }

                    //previousBlockHash is not the same, it must be a reorg
                    if (previousBlockHash != previousBlock.block_hash){
                        await this.db.endTransaction()
                        console.log("A reorg has been detected at block " + nextBlockHeight + ". Cleaning blocks...")
                        const preReorgBlock = lastProcessedBlockIndex
                        await this.verifyReorg(this.blockchainInfoLastBlock)
                        // Re-clamp: same as the pre-loop guard and the node-tip regression path.
                        lastProcessedBlockIndex = this.lastProcessedBlockIndex = Math.max(await this.db.getLastBlockIndex(), this.startBlockIndex - 1)
                        // Count rolled-back blocks as the difference between the pre-reorg tip
                        // and the newly confirmed last good block so the log entry is actionable.
                        const rolledBackCount = Math.max(0, preReorgBlock - lastProcessedBlockIndex)
                        lastProcessedTxIndex = await this.db.getLastTxIndex()
                        blocksQuantity = 0
                        transactionsCount = 0
                        validTransactionsCount = 0
                        outputCount = 0
                        startTimeStamp = Date.now()
                        console.log("Blocks were updated (" + rolledBackCount + " blocks rolled back)")
                        continue
                    }
                }



                //If there are no blocks pending then start the database transaction
                if (blocksQuantity == 0){
                    await this.db.beginTransaction()
                }
                
                if (!(await this.db.insertBlock(
                    {
                        block_index:nextBlockHeight,
                        block_hash:nextBlockHash, 
                        block_time:block.timestamp,
                        previous_block_hash:previousBlockHash
                    }
                ))){
                    // insertBlock's error path already rolled the block transaction back.
                    console.log("Error trying to insert a Block to the database")
                    await resetAfterRollback()
                    continue main_parsing
                }

                //Soft-expire open dispensers past their expiration (marks them with
                //this block height instead of deleting, so a reorg can restore them).
                //false means the UPDATE failed and the block transaction was already
                //rolled back; continuing would land every subsequent write on fresh
                //autocommit connections OUTSIDE any transaction (durable rows the
                //rollback was meant to discard), so retry the block instead.
                if ((await this.db.deleteOpenDispensers(nextBlockHeight, block.timestamp)) !== true){
                    console.error(`deleteOpenDispensers failed at block ${nextBlockHeight}; block rolled back, retrying`)
                    await resetAfterRollback()
                    continue main_parsing
                }

                // Load the set of open-dispenser addresses once for this block (after
                // expiring stale ones above) so parseTransaction can test each output
                // against it in JS instead of issuing one DB query per output; the
                // per-output lookup was thousands of serialized round-trips per mainnet
                // block. Kept current within the block by .add()ing any dispenser opened
                // by a transaction below, matching the previous per-output query timing.
                // null signals the query failed: decoding the block against an empty set
                // would silently drop every dispense output on this instance only, so
                // retry the block instead.
                let openDispenserAddresses = await this.db.getAllOpenDispenserAddresses()
                if (openDispenserAddresses == null){
                    console.error(`Could not load open dispenser addresses for block ${nextBlockHeight}; retrying block`)
                    await this.db.endTransaction()
                    await resetAfterRollback()
                    continue main_parsing
                }

                //Loop through the transactions and saving only the ones that have valid data
                var transactions = block.transactions
                blocksCount = blocksCount + 1

                for (let txIndex=0;txIndex < transactions.length;txIndex++){
                    let nextTransaction = transactions[txIndex]
                    let nextTransactionHash = null
                    let parseResult = null

                    // Insert-quarantine skip: this tx position deterministically failed to
                    // INSERT on a prior pass of this block. Skip it exactly like a quarantined
                    // parse-throw - PARSE_ERROR event, NO tx_index consumed, no insert - so a
                    // poison row cannot wedge the block. The block transaction is open here
                    // (beginTransaction ran when blocksQuantity hit 0), so the event commits
                    // with the block. Deterministic across instances, so parity holds.
                    if (insertQuarantine.has(nextBlockHeight + ':' + txIndex)){
                        this.parseErrors++
                        let quarantinedHash = null
                        try { quarantinedHash = nextTransaction.getId() } catch(_){ /* unparseable id; leave null */ }
                        let eventResult = await this.db.insertEvent("PARSE_ERROR", {
                            block_index: nextBlockHeight,
                            tx_position: txIndex,
                            tx_hash: quarantinedHash,
                            error: 'deterministic INSERT failure (quarantined after ' + TX_PARSE_MAX_RETRIES + ' block retries)'
                        }, block.timestamp)
                        if (eventResult === false){
                            // insertEvent already rolled the block transaction back
                            await resetAfterRollback()
                            continue main_parsing
                        }
                        continue
                    }

                    try {
                        nextTransactionHash = nextTransaction.getId()
                        parseResult = await this.parseTransaction(nextTransaction, openDispenserAddresses)
                    } catch (e){
                        if (e && e.rpcLookupFailure){
                            // A prevout/fee-output RPC lookup failed even after the
                            // connector's internal retries. That is node/infrastructure
                            // trouble, not a poison transaction: quarantining would make
                            // this instance skip a tx every healthy instance accepts
                            // (instance-dependent block contents). Retry the block
                            // indefinitely instead; rpc_errors/health make the stall
                            // visible while the node recovers.
                            console.error(`RPC lookup failed in block ${nextBlockHeight} (tx position ${txIndex}), retrying block:`, e)
                            await this.db.endTransaction()
                            await resetAfterRollback()
                            continue main_parsing
                        }

                        if (txParseRetryHeight != nextBlockHeight){
                            txParseRetryHeight = nextBlockHeight
                            txParseRetryCount = 0
                        }
                        txParseRetryCount++

                        if (txParseRetryCount <= TX_PARSE_MAX_RETRIES){
                            // Could be transient (DB hiccup inside parseTransaction):
                            // roll the block back and re-parse it from scratch.
                            console.error(`parseTransaction failed in block ${nextBlockHeight} (tx position ${txIndex}, attempt ${txParseRetryCount}/${TX_PARSE_MAX_RETRIES}), retrying block:`, e)
                            await this.db.endTransaction()
                            await resetAfterRollback()
                            continue main_parsing
                        }

                        // The transaction keeps throwing after whole-block retries: treat it
                        // as a poison transaction and quarantine it (skip + audit event) so
                        // one undecodable tx cannot wedge the pipeline at this height forever.
                        this.parseErrors++
                        console.error(`Quarantining undecodable tx in block ${nextBlockHeight} (tx position ${txIndex}, hash ${nextTransactionHash}) after ${TX_PARSE_MAX_RETRIES} block retries:`, e)
                        let eventResult = await this.db.insertEvent("PARSE_ERROR", {
                            block_index: nextBlockHeight,
                            tx_position: txIndex,
                            tx_hash: nextTransactionHash,
                            error: String((e && e.message) || e)
                        }, block.timestamp)
                        if (eventResult === false){
                            // insertEvent already rolled the block transaction back
                            await resetAfterRollback()
                            continue main_parsing
                        }
                        continue
                    }
                    
                    if (parseResult != null){
                        let dispenseOutputs = parseResult['dispenseOutputs']
                        
                        if (//the transaction must have a data and a source or at least some possible dispenses
                            (
                                (parseResult["data"].length > 0) 
                                && 
                                (parseResult["source"] != null)
                            )
                            || dispenseOutputs.length > 0
                        ){
                            lastProcessedTxIndex = lastProcessedTxIndex + 1
                            validTransactionsCount = validTransactionsCount + 1

                            let decodedData = ""
                            if (parseResult["data"].length > 0) {
                                // F5: a tx can carry BOTH an XChain OP_RETURN and money-bearing
                                // dispense/payment outputs. When the ACTION is oversized or names
                                // an unknown action, do NOT drop those outputs: treat the bad
                                // action as no-action (empty data, null raw_data) and fall through
                                // so the dispense/payment outputs are still recorded. Only skip the
                                // whole tx when there is nothing else to record. The no-output skip
                                // path is left byte-identical (still consumes a tx_index and
                                // continues) - changing tx_index assignment for invalid-action txs
                                // would diverge from already-decoded history.
                                let hasOutputs = (dispenseOutputs.length > 0 || parseResult["paymentOutputs"].length > 0)
                                if (parseResult["compiledDataLength"] > MAX_ACTION_DATA_LENGTH) {
                                    this.parseErrors++
                                    console.error(`Skipping ACTION for tx ${nextTransactionHash}: ACTION data exceeds maximum length (${parseResult["compiledDataLength"]} > ${MAX_ACTION_DATA_LENGTH})`)
                                    if (!hasOutputs) continue
                                    decodedData = ""
                                    parseResult["rawData"] = null
                                } else {
                                    // : canonicalize (tokenize + alias-expand) at the byte
                                    // level via the shared helper BEFORE string-decoding, so the
                                    // canonical name (always plain ASCII) rides through the same
                                    // strict/lenient decode as everything else and the DB ends up
                                    // alias-free regardless of which spelling was used on-chain.
                                    // canonical.buffer equals parseResult["data"] unchanged whenever
                                    // no rewrite is needed (including the unknown-name case), so this
                                    // decode is byte-for-byte identical to decoding the raw data.
                                    const canonical = canonicalizeActionPayload(parseResult["data"])
                                    try {
                                        decodedData = strictTextDecoder.decode(canonical.buffer)
                                    } catch (e) {
                                        this.parseErrors++
                                        decodedData = lenientTextDecoder.decode(canonical.buffer)
                                        console.error(`Tx ${nextTransactionHash}: ACTION data contains invalid UTF-8, decoded with replacement characters`, e)
                                    }

                                    if (!canonical.isKnown) {
                                        this.parseErrors++
                                        console.error(`Skipping ACTION for tx ${nextTransactionHash}: unknown ACTION name '${canonical.rawActionName.substring(0, 32)}'`)
                                        if (!hasOutputs) continue
                                        decodedData = ""
                                        parseResult["rawData"] = null
                                    }
                                }
                            }
                            
                            let insertResult = await this.db.insertTransaction({
                                index: lastProcessedTxIndex,
                                hash: nextTransactionHash,
                                block_index: nextBlockHeight,
                                source: parseResult["source"],
                                destination: parseResult["destination"],
                                amount: parseResult["amount"],
                                fee: 0,
                                data: decodedData,
                                raw_data: parseResult["rawData"] || null

                            })
                            if (insertResult === this.db.POISON_ROW){
                                // Deterministic content/constraint rejection (block already
                                // rolled back by insertTransaction). Retrying the block would
                                // wedge it forever. Bound the retries like a parse-throw, then
                                // quarantine this tx position so the re-parse skips it. (The
                                // retry margin guards against a misclassified transient error;
                                // the errno set is conservative, so this normally quarantines
                                // on the first exceedance.)
                                if (insertQuarantineHeight != nextBlockHeight){
                                    insertQuarantineHeight = nextBlockHeight
                                    insertQuarantineCount = 0
                                }
                                insertQuarantineCount++
                                if (insertQuarantineCount > TX_PARSE_MAX_RETRIES){
                                    insertQuarantine.add(nextBlockHeight + ':' + txIndex)
                                    console.error(`Quarantining tx with deterministic INSERT failure in block ${nextBlockHeight} (tx position ${txIndex}, hash ${nextTransactionHash}) after ${TX_PARSE_MAX_RETRIES} block retries`)
                                } else {
                                    console.error(`insertTransaction deterministic failure in block ${nextBlockHeight} (tx position ${txIndex}, attempt ${insertQuarantineCount}/${TX_PARSE_MAX_RETRIES}), retrying block`)
                                }
                                await resetAfterRollback()
                                continue main_parsing
                            } else if (insertResult === false){
                                // Transient INSERT failure; insertTransaction's error path
                                // already rolled the block back. Retry indefinitely (never skip
                                // a tx a healthy instance accepts).
                                await resetAfterRollback()
                                continue main_parsing
                            } else {
                                //Store dispenses outputs. false means the INSERT failed and
                                //the block transaction was already rolled back: stop writing
                                //(anything further would land outside a transaction) and
                                //retry the block.
                                for (let nextOutput of dispenseOutputs){
                                    nextOutput.txIndex = lastProcessedTxIndex
                                    let insertResult = await this.db.insertTransactionOutput(
                                        nextOutput
                                    )
                                    if (insertResult === false){
                                        console.error(`insertTransactionOutput (dispense) failed at block ${nextBlockHeight}; block rolled back, retrying`)
                                        await resetAfterRollback()
                                        continue main_parsing
                                    }
                                    if (insertResult === this.db.DUPLICATED_TRANSACTION){
                                        console.warn(`Duplicate transaction_output on insert (block_index=${nextBlockHeight}, tx_index=${lastProcessedTxIndex}, vout=${nextOutput.vout}); possible stale pre-reorg row not cleaned up by deleteBlockByIndex`)
                                    }
                                }

                                //Store payment outputs the indexer needs to read:
                                //  • COINPAY: every native-coin output (settlement is determined
                                //    per-output; the indexer fans out per-output by LEFT JOIN-ing
                                //    transaction_outputs in getDecoderBlockData).
                                //  • Any action: the native-coin fee output paying the protocol
                                //    FEE_DESTINATION, so the indexer can validate native-coin fee
                                //    payments (xchain-indexer/src/utility.js detectFeePaymentMode /
                                //    validateNativeCoinFee). Captured only when feeDestination is set.
                                let isCoinpay = decodedData.startsWith("COINPAY|")
                                if (isCoinpay || this.feeDestination){
                                    for (let nextOutput of parseResult["paymentOutputs"]){
                                        if (!isCoinpay && nextOutput.destinationAddress !== this.feeDestination)
                                            continue
                                        nextOutput.txIndex = lastProcessedTxIndex
                                        let insertResult = await this.db.insertTransactionOutput(
                                            nextOutput
                                        )
                                        if (insertResult === false){
                                            console.error(`insertTransactionOutput (payment) failed at block ${nextBlockHeight}; block rolled back, retrying`)
                                            await resetAfterRollback()
                                            continue main_parsing
                                        }
                                        if (insertResult === this.db.DUPLICATED_TRANSACTION){
                                            console.warn(`Duplicate transaction_output on insert (block_index=${nextBlockHeight}, tx_index=${lastProcessedTxIndex}, vout=${nextOutput.vout}); possible stale pre-reorg row not cleaned up by deleteBlockByIndex`)
                                        }
                                    }
                                }
                                
                                //Catch any dispenser message to add it to
                                //the list of possible dispenses.
                                //
                                //v0 wire format (must stay in sync with the
                                //indexer (see xchain-indexer/src/actions/dispenser.js):
                                //  DISPENSER|0|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT
                                //    |GIVE_OWNERSHIP|GIVE_ESCROW
                                //    |GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS
                                //    |FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS
                                //    |EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
                                if (decodedData.startsWith("DISPENSER")){
                                    let decodedDataSplit = decodedData.split("|")
                                    let commandVersion = decodedDataSplit[1]

                                    // EXPIRATION (index 14) is OPTIONAL on v0: the indexer
                                    // substitutes a block-time default when it is omitted, so the
                                    // required fields end at GET_ADDRESS (index 10). Gate on >= 14
                                    // (through ORACLE_ADDRESS) rather than >= 15 so an
                                    // EXPIRATION-less-but-otherwise-valid open is still tracked
                                    // instead of silently dropped.
                                    if (parseInt(commandVersion, 10) === 0 && decodedDataSplit.length >= 14){
                                        let giveCoin = decodedDataSplit[2]
                                        let getCoin = decodedDataSplit[7]
                                        let getAddress = decodedDataSplit[10]

                                        // Treat a missing token OR an empty-string token as an
                                        // omitted EXPIRATION and substitute the same default the
                                        // indexer uses; only a present, non-empty value is validated.
                                        let expirationToken = decodedDataSplit[14]
                                        let expiration
                                        if (expirationToken === undefined || expirationToken === "") {
                                            expiration = this.getDefaultExpiration(block.timestamp)
                                        } else {
                                            expiration = Number(expirationToken)
                                        }

                                        if (isNaN(expiration) || expiration < 0 || expiration > 4294967295) {
                                            this.parseErrors++
                                            console.error(`Skipping dispenser in tx ${nextTransactionHash}: invalid expiration value '${decodedDataSplit[14]}'`)
                                        } else if ((getCoin != "") || (giveCoin != "")){
                                            // The dispenser operates on GET_ADDRESS when a delegated
                                            // address is given, otherwise on the tx SOURCE (indexer
                                            // default). The indexer matches dispense triggers on this
                                            // operating address (get_address_id), so the decoder must
                                            // register and gate on the SAME key or dispenses paid to a
                                            // delegated address are never emitted.
                                            const operatingAddress = (getAddress && getAddress.length > 0)
                                                ? getAddress
                                                : parseResult["source"]
                                            if (!(await this.db.insertDispenser({
                                                txIndex: lastProcessedTxIndex,
                                                address: operatingAddress,
                                                expiration: expiration
                                            }))){
                                                // insertDispenser's error path already rolled the block back.
                                                await resetAfterRollback()
                                                continue main_parsing
                                            }
                                            // Keep the in-memory open-dispenser set current so a
                                            // later transaction in this same block that pays this
                                            // freshly-opened dispenser is still recognized as a
                                            // dispense (mirrors the old per-output DB lookup).
                                            if (operatingAddress)
                                                openDispenserAddresses.add(operatingAddress)
                                        }
                                    }
                                }
                            }
                        } else {
                            if ((parseResult["data"].length > 0) && (parseResult["source"] == null)){
                                console.error(`Skipping tx ${nextTransactionHash}: XChain data found but source address could not be resolved`)
                            }
                        }
                    }
                    
                    outputCount = outputCount + nextTransaction.outs.length
                }
                
                transactionsCount = transactionsCount + transactions.length
                
                //If the pendings blocks are enough, then commit the transaction and print statistics
                if ((blocksQuantity == DB_TRANSACTION_BLOCKS_QUANTITY-1) || (nextBlockHeight == this.blockchainInfoLastBlock)){
                    if ((nextBlockHeight % LOG_BLOCK_INTERVAL === 0) || ((this.blockchainInfoLastBlock - nextBlockHeight) <= SYNCED_THRESHOLD)) {
                        console.log("Parsing block "+(nextBlockHeight)+"("+nextBlockHash+") Txs ("+transactionsCount+") Outputs ("+outputCount+")")
                        console.log("Inserting data Blocks ("+blocksCount+") Valid Transactions ("+validTransactionsCount+")")
                    }
                    const committed = await this.db.commitTransaction()
                    if (!committed){
                        // commitTransaction returned false: the commit failed and the whole
                        // block batch was rolled back (endTransaction). Do NOT advance the tip
                        // to nextBlockHeight, which would permanently skip the rolled-back
                        // window and leave a hole in the decoded chain. Reset to the last
                        // durably committed block and retry, mirroring the block-decode
                        // recovery path above.
                        console.error(`Commit failed at block ${nextBlockHeight}; resetting to last committed block and retrying`)
                        lastProcessedBlockIndex = this.lastProcessedBlockIndex = Math.max(await this.db.getLastBlockIndex(), this.startBlockIndex - 1)
                        lastProcessedTxIndex = await this.db.getLastTxIndex()
                        blocksQuantity = 0
                        // Reset the in-memory log/ETA accumulators too, as the reorg
                        // recovery path does. The rolled-back batch never reached the
                        // DB, so leaving these set would double-count transactions and
                        // skew the ms/block ETA on the retry. Logging-only, no tip effect.
                        transactionsCount = 0
                        validTransactionsCount = 0
                        outputCount = 0
                        blocksCount = 0
                        startTimeStamp = Date.now()
                        await this.sleep(3000)
                        continue
                    }

                    // The block committed: any poison-tx positions for it are now permanently
                    // recorded (PARSE_ERROR) and skipped, so drop them. Keeps insertQuarantine
                    // bounded to the block being retried and prevents a stale height:pos entry
                    // from surviving a later reorg that changes this height's content.
                    if (insertQuarantine.size > 0) insertQuarantine.clear()

                    // Hard-purge dispensers soft-expired at a reorg-safe depth. Runs
                    // AFTER the block transaction commits (a transient failure here
                    // must not roll back committed block data) and is deterministic
                    // across nodes (keyed off canonical height, not wall clock).
                    await this.db.purgeExpiredDispensers(nextBlockHeight - DISPENSER_EXPIRE_SAFE_DEPTH)

                    blocksCount = 0
                    transactionsCount = 0
                    validTransactionsCount = 0
                    outputCount = 0
                    
                    let endTimeStamp = Date.now()
                    
                    let msPerBlock = ((endTimeStamp - startTimeStamp)/DB_TRANSACTION_BLOCKS_QUANTITY)
                    startTimeStamp = Date.now()
                    
                    let msLeft = (this.blockchainInfoLastBlock - nextBlockHeight)*msPerBlock
                    
                    if (msLeft > 0){
                        let msPerBlockFormatted = this.millisecondsToTimeString(msPerBlock)
                        let msLeftFormatted = this.millisecondsToTimeString(msLeft)
                        console.log("Last block time ("+msPerBlockFormatted+"). ETA: "+msLeftFormatted)
                    }
                    
                    blocksQuantity = -1
                }
                
                blocksQuantity = blocksQuantity + 1
                lastProcessedBlockIndex = this.lastProcessedBlockIndex = nextBlockHeight
            }
        }
    }
    
    async updateMempool(){
        if (!this.mempoolBusy) {
            let mempoolStartTime = Date.now()
            this.mempoolBusy = true
            let rawMempool = []
            try {
                let rawMempoolUnordered = await this.connector.getRawMempool()

                // Dedup + single O(n log n) sort. The old per-txid binary-insert
                // (bs + splice) was O(n^2) in mempool size every poll cycle, a CPU
                // hazard under a mempool flood. ORDER CONTRACT: descending
                // lexicographic, i.e. exactly what the inverted bs comparator
                // `needle.localeCompare(element)` produced; db.js
                // deleteAndCompareTxsNotInList binary-searches this array with
                // that same comparator and silently breaks on any other order.
                rawMempool = Array.from(new Set(rawMempoolUnordered))
                    .sort((a, b) => b.localeCompare(a))

            } catch (error) {
                console.log(error)
                console.log("There were problems getting the mempool, trying again later.", error)
                this.mempoolBusy = false
                return
            }

            //let transactionsCount = 0
            let validTransactionsCount = 0

            try {
            // All mempool DB work runs on this.mempoolDb, never this.db, so it stays outside the
            // block loop's open transaction (M-19). Deletes txs no longer in the node mempool and
            // drops txs already stored, leaving rawMempool holding only the new arrivals.
            let deletedInfo = await this.mempoolDb.deleteAndCompareTxsNotInList(rawMempool)

            let deletedTransactionsCount = deletedInfo.transactionsDeleted
            
            let i = 0
            while (i < rawMempool.length) {
                let nextRawMempoolChunk = rawMempool.slice(i, i + MEMPOOL_BATCH_SIZE)

                let nextTxsHex = []
                try {
                    nextTxsHex = await this.connector.getRawTransactions(nextRawMempoolChunk)

                } catch (err) {
                    console.error(`mempool: failed to fetch raw transactions for batch starting at index ${i}: `, err)
                    console.error("Skipping batch and continuing...", err)
                    i = i + MEMPOOL_BATCH_SIZE
                    await this.sleep(1000)
                    continue
                }

                for (let nextTxHexIndex = 0; nextTxHexIndex < nextTxsHex.length; nextTxHexIndex++) {
                    let nextTxHex = nextTxsHex[nextTxHexIndex]

                    if (nextTxHex == null) {
                        continue
                    }

                    let nextTx
                    try {
                        nextTx = this.xchainBlockDecoder.transactionFromHex(nextTxHex)
                    } catch (err) {
                        this.parseErrors++
                        console.error(`Mempool: failed to parse tx hex (batch index ${nextTxHexIndex}): `, err)
                        continue
                    }

                    if (nextTx.ins.length === 0) {
                        // HogEx / MWEB-only transactions have no inputs and carry no XChain data
                        continue
                    }

                    let nextTransactionHash = nextTx.getId()

                    let parseResult = null
                    try {
                        // Pass mempoolDb so the pubkey-capture writes inside parseTransaction also
                        // stay off the block transaction (M-19).
                        parseResult = await this.parseTransaction(nextTx, undefined, this.mempoolDb)
                    } catch (err) {
                        // The surrounding try has no catch (only a finally for the busy
                        // flag), so a single undecodable mempool tx would abort the whole
                        // mempool update cycle. Skip just the tx; it is retried on the
                        // next cycle anyway since it never reaches the database.
                        this.parseErrors++
                        console.error(`Mempool: parseTransaction failed for tx ${nextTransactionHash}, skipping:`, err)
                        continue
                    }

                    if (parseResult == null) {
                        continue
                    }

                    let mempoolData = parseResult["data"]
                    if (mempoolData != null && mempoolData.length > 0) {
                        // Mirror the confirmed-block path (F5): apply the same two guards so a
                        // pending tx never shows one thing and then silently vanishes on confirm.
                        // A tx can carry BOTH an invalid/oversized ACTION and money-bearing
                        // dispense/payment outputs; when it does, do NOT drop the whole tx -
                        // treat the bad action as no-action (null data) and still record the
                        // pending tx, exactly as F5 does at confirmation. Only skip the whole tx
                        // when there is nothing else to record.
                        let hasOutputs = ((parseResult["dispenseOutputs"]?.length > 0) || (parseResult["paymentOutputs"]?.length > 0))

                        // Guard 1: oversized payloads.
                        if (parseResult["compiledDataLength"] > MAX_ACTION_DATA_LENGTH) {
                            this.parseErrors++
                            console.error(`Mempool: tx ${nextTransactionHash}: ACTION data exceeds maximum length (${parseResult["compiledDataLength"]} > ${MAX_ACTION_DATA_LENGTH})`)
                            if (!hasOutputs) continue
                            mempoolData = null
                        } else {
                            // Guard 2: unknown ACTION names (expand aliases first so an
                            // alias-named tx doesn't show as pending and then silently vanish).
                            // : shared with the confirmed-block path via
                            // canonicalizeActionPayload so the two gates cannot drift again.
                            const canonical = canonicalizeActionPayload(mempoolData)
                            if (!canonical.isKnown) {
                                this.parseErrors++
                                console.error(`Mempool: tx ${nextTransactionHash}: unknown ACTION name '${canonical.rawActionName.substring(0, 32)}'`)
                                if (!hasOutputs) continue
                                mempoolData = null
                            } else {
                                mempoolData = canonical.buffer
                            }
                        }
                    }

                    // Store the canonical payload as the SAME UTF-8 string the
                    // confirmed-block path writes (strictTextDecoder over
                    // canonical.buffer, lenient fallback on invalid UTF-8), not
                    // hex. Otherwise mempool_transactions.data ("434f..." hex)
                    // and transactions.data ("COINPAY|..." text) hold the same
                    // on-wire ACTION in two encodings, so any content-correlation
                    // between a pending row and its confirmed twin silently
                    // mismatches (uuid:26220713). mempoolData here is
                    // canonical.buffer (a Uint8Array) for a known ACTION.
                    let mempoolDataString = null
                    if (mempoolData != null) {
                        try {
                            mempoolDataString = strictTextDecoder.decode(mempoolData)
                        } catch (e) {
                            this.parseErrors++
                            mempoolDataString = lenientTextDecoder.decode(mempoolData)
                            console.error(`Mempool: tx ${nextTransactionHash}: ACTION data contains invalid UTF-8, decoded with replacement characters`, e)
                        }
                    }

                    if (!(await this.mempoolDb.insertMempoolTransaction({
                        hash: nextTransactionHash,
                        source: parseResult["source"],
                        destination: parseResult["destination"],
                        amount: parseResult["amount"],
                        fee: 0,
                        data: mempoolDataString

                    }))) {
                        await this.sleep(3000)
                        continue
                    } else {
                        if ((parseResult["data"] != null) && (parseResult["data"].length > 0)) {
                            validTransactionsCount = validTransactionsCount + 1
                        }
                    }
                }

                i = i + MEMPOOL_BATCH_SIZE
                //await this.sleep(10000)
            }

            let mempoolEndTime = Date.now()
            let timeString = this.millisecondsToTimeString(mempoolEndTime - mempoolStartTime)

            console.log("Mempool updated!"
                + " Transactions (" + rawMempool.length + " in mempool, " + validTransactionsCount + " valid, " + deletedTransactionsCount + " less) [" + timeString + "]")
            } finally {
                // Always clear the busy flag, even if a DB or parse operation above threw.
                // Otherwise a single transient failure would leave mempool tracking frozen
                // for the rest of the process lifetime.
                this.mempoolBusy = false
            }
        } else {
            console.log("Mempool is still busy")
        }
    }
    
}

module.exports = XChainDecoder
// Exported for the cross-service regression suite, which asserts this equals the
// encoder's compiled-push guard and the canonical protocol constant.
module.exports.MAX_ACTION_DATA_LENGTH = MAX_ACTION_DATA_LENGTH
// Exported for the compiled-push-size conformance test, which pins this formula
// against bitcoin.script.compile and the encoder's identical helper.
module.exports.compiledPushSize = compiledPushSize
// Exported so a regression test can pin it >= the deepest per-chain reorg window.
module.exports.DISPENSER_EXPIRE_SAFE_DEPTH = DISPENSER_EXPIRE_SAFE_DEPTH
// Exported for the F3 regression test (DOGE large-output bufferutils-patch self-check).
module.exports.bigIntBufferutilsActive = bigIntBufferutilsActive
// Exported for the alias-canonicalization unit/regression tests () and
// so the ActionManifestConformance test can pin VALID_ACTION_NAMES/ACTION_ALIASES.
module.exports.canonicalizeActionPayload = canonicalizeActionPayload
module.exports.VALID_ACTION_NAMES = VALID_ACTION_NAMES
module.exports.ACTION_ALIASES = ACTION_ALIASES