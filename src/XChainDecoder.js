/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
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
const bs = require("binary-search")
const strictTextDecoder = new TextDecoder('utf-8', { fatal: true })
const lenientTextDecoder = new TextDecoder('utf-8')

//We need to init the ecc to parse taproot addresses from output scripts
bitcoin.initEccLib(ecc);

const CHECK_BLOCK_DELAY_MS = 1000 //1 second to continously ask for new block when all has been parsed
const BLOCKCHAIN_INFO_REFRESH_MS = 30000 //Re-poll the node tip at least this often during catch-up so reported lag stays accurate
const MEMPOOL_INTERVAL = 60000 //1 second between mempool checks
const MEMPOOL_BATCH_SIZE = 1000

const MAGIC_WORD = "XCHN"
const MAGIC_WORD_BUFFER = Buffer.from(MAGIC_WORD)
const P2SH_BUFFER = Buffer.from("p2sh")
const P2WSH_BUFFER = Buffer.from("p2wsh")

const SYNCED_THRESHOLD = 3 //Maximum blocks behind to be synced
// Soft-expired dispensers (marked, not deleted, so a reorg can restore them) are
// hard-purged once this many blocks deep — well past any realistic reorg, and a
// pure function of canonical height so every node purges identically.
const DISPENSER_EXPIRE_SAFE_DEPTH = 100
const MIN_VERIFICATION_PROGRESS_TO_PARSE = 0.99 //How much progress the node need to have to start parsing

// Maximum compiled on-chain ACTION push, in bytes (measured before
// bitcoin.script.decompile strips the OP_PUSHDATA prefix — see compiledDataLength).
// This is the protocol arbiter for ACTION size: any tx whose compiled push
// exceeds this is dropped. Canonical source of truth + the encoder's matching
// guard: xchain-documentation/protocol/constants.js (MAX_ACTION_DATA_LENGTH) /
// xchain-encoder validator MAX_COMPILED_ACTION_DATA_LENGTH. Kept equal by the
// cross-service regression suite.
const MAX_ACTION_DATA_LENGTH = 8192
const VALID_ACTION_NAMES = new Set([
    'ADDRESS', 'AIRDROP', 'ANCHOR', 'ATTEST',
    'BATCH', 'BROADCAST', 'CALLBACK', 'COINPAY', 'COLLECT',
    'DELEGATE', 'DEPLOY', 'DEPOSIT', 'DESTROY', 'DISPENSER',
    'DIVIDEND', 'EXECUTE', 'FILE', 'ISSUE', 'LINK', 'LIST', 'MESSAGE', 'MINT',
    'ORDER', 'PRICE', 'SEND', 'SLEEP', 'STAKE', 'SWAP',
    'SWEEP', 'UNSTAKE', 'WITHDRAW'
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

const DB_TRANSACTION_BLOCKS_QUANTITY = 1 //How many transactions need to be processed before inserting the data into the database
const LOG_BLOCK_INTERVAL = 1000 //During catch-up sync, only log progress every N blocks

// How many times a block is re-parsed after a transaction-level parse throw before
// the offending transaction is quarantined (skipped + PARSE_ERROR event). Throws out
// of parseTransaction mix transient causes (node RPC, DB) with deterministic ones
// (poison tx). Retrying first means a transient blip can never make this instance
// skip a transaction that other decoder instances accept; only a tx that fails every
// attempt is quarantined, which is deterministic across instances running this code.
const TX_PARSE_MAX_RETRIES = 3

class XChainDecoder {
    constructor(network, dbUrl, dbPort, dbName, dbUser, dbPassword, nodeUrl, nodePort, nodeUser, nodePassword, auxPow, feeDestination) {
        this.network = CryptoNetworks.getBitcoinJsNetwork(network)

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
        this.xchainBlockDecoder = new XChainBlockDecoder(network)
      
        this.db = null
        this.mempoolDb = null
        this.fm = null
      
        this.debugTime = {}
      
        this.synced = false

        this.lastProcessedBlockIndex = -1
        this.blockchainInfoLastBlock = -1
        this.mempoolInterval = null
        this.mempoolBusy = false

        this.stopFlag = false

        this.auxPow = auxPow

        this.rpcErrors = 0
        this.parseErrors = 0
    }
    
    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
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
        return this.synced
    }

    getSyncStatus() {
        if (this.lastProcessedBlockIndex === -1) {
            return { last_processed_block: null, node_height: null, lag: null }
        }
        return {
            last_processed_block: this.lastProcessedBlockIndex,
            node_height: this.blockchainInfoLastBlock,
            lag: this.blockchainInfoLastBlock - this.lastProcessedBlockIndex
        }
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
        return await this.parseTransaction(bitcoin.Transaction.fromHex(rawTransaction))
    }
    
    //Gets the address from the output specified by the transaction hash id and the output index
    async getSourceFromOutput(txId, outputIndex){
        let source = null
        let output = null
        let outputTransaction = null
        
        try {
            //Obtaining the output
            let outputRawTransaction = await this.connector.getRawTransaction(txId)
            outputTransaction = bitcoin.Transaction.fromHex(outputRawTransaction)
            output = outputTransaction.outs[outputIndex]
        } catch (err){
            this.rpcErrors++
            console.error(`getSourceFromOutput: failed to fetch tx ${txId} (output ${outputIndex}): `, err)
        }
        
        if (output != null){
            let script = output.script
            //Check if output is a P2SH or P2WSH data-carrying reveal output. If so,
            //the spent output's own address is the script (commit) address, not the
            //signer — so walk back one hop to the commit tx's first input and take
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
                let prevRawTransaction = await this.connector.getRawTransaction(prevTxHash)
                let prevTransaction = bitcoin.Transaction.fromHex(prevRawTransaction)
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

    // For a P2SH/P2WSH reveal, the native-coin fee output lives on the funding (commit) transaction —
    // the wallet/SDK place the fee output on the first tx they generate, and the reveal (this action's
    // tx) spends that commit's P2SH outputs. Fetch the funding tx and return any output paying the
    // protocol FEE_DESTINATION, shaped as a paymentOutput, so the indexer sees it among this action's
    // transaction_outputs and can validate the native-coin fee. Deterministic (same commit → same
    // output). Returns [] when no fee destination is configured, the txid is missing, or the lookup
    // fails (the action then falls back to XCHAIN-balance fee handling, as before).
    async findFundingFeeOutputs(fundingTxId){
        let results = []
        if (!this.feeDestination || !fundingTxId) return results
        try {
            let fundingTxHex = await this.connector.getRawTransaction(fundingTxId)
            if (!fundingTxHex) return results
            let fundingTx = bitcoin.Transaction.fromHex(fundingTxHex)
            for (let vout = 0; vout < fundingTx.outs.length; vout++){
                let output = fundingTx.outs[vout]
                let outputAddress = null
                try {
                    if (!this.isFutureSegwitScript(output.script))
                        outputAddress = bitcoin.address.fromOutputScript(output.script, this.network)
                } catch (err){
                    //the output script has no matching address — skip
                }
                if (outputAddress && outputAddress === this.feeDestination){
                    results.push({ vout: vout, destinationAddress: outputAddress, amount: output.value })
                }
            }
        } catch (err){
            this.rpcErrors++
            console.error(`findFundingFeeOutputs: failed to fetch funding tx ${fundingTxId}:`, err.message)
        }
        return results
    }

    async parseTransaction(transaction, openDispenserAddresses){
        // openDispenserAddresses is a Set of every open-dispenser address, loaded
        // once per block by the caller. Membership is tested in JS here instead of
        // issuing a DB round-trip per output. Defensive fallback to an empty Set
        // keeps callers that don't pass it (e.g. some unit tests) working.
        if (!openDispenserAddresses) openDispenserAddresses = new Set()
        let nextTxId = transaction.getId()
        let firstInputTxId = util.uint8ArrayToHex(Buffer.from(transaction.ins[0].hash).reverse())
        let standardInput = ("standard_input" in transaction.ins[0]?transaction.ins[0]["standard_input"]:true)
        let dispenseOutputs = []
        let paymentOutputs = []
        // For a P2SH/P2WSH reveal, the funding (commit) tx — whose outputs this reveal spends — is the
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
                                            this.rpcErrors++
                                            console.error(`P2SH data extraction failed for input ${txInputIndex} of tx ${nextTxId}:`, e)
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
                                            this.rpcErrors++
                                            console.error(`P2WSH data extraction failed for input ${txInputIndex} of tx ${nextTxId}:`, e)
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
                        // The encoder's dataToPubkey() zero-pads the ciphertext only on
                        // the FINAL partial chunk to fill the 32-byte pubkey halves, but a
                        // full 64-byte chunk carries pseudo-random AES-128-CTR ciphertext
                        // whose last byte is 0x00 ~1/256 of the time. Stripping it dropped a
                        // real ciphertext byte, decrypted one byte short, and silently
                        // corrupted the payload (bitcoin.script.decompile then returned null
                        // on the truncated buffer). Instead we decrypt the full chunk; AES-CTR
                        // is a stream cipher, so any zero-padding on the final chunk decrypts
                        // to harmless trailing keystream bytes that fall outside the payload's
                        // own self-describing compiled-script length and are discarded when the
                        // reassembled buffer is run through bitcoin.script.decompile() below.
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
            
            // Capture compiled byte length before decompile strips OP_PUSHDATA2's 3-byte overhead.
            // The MAX_ACTION_DATA_LENGTH guard downstream must measure the on-chain payload size,
            // not the decompiled-and-shortened buffer.
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
                        if (decompiledData.length > 1){
                            rawData = decompiledData[1]
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
                    let addressId = await this.db.getAddressId(source)
                    if (addressId && !(await this.db.hasPubkey(addressId))){
                        await this.db.insertPubkey(addressId, pubkey)
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
            // longer has — a deep reorg, a node rollback, or a restart onto a
            // shorter chain. getBlockHash(lastBlockIndex) would throw "Block height
            // out of range", and the transient-error catch below would retry it
            // forever instead of deleting it. Detect this with a deterministic
            // height compare against the tip passed in (no brittle RPC-error-string
            // matching). nodeTip is undefined for legacy callers (e.g. existing
            // verifyReorg-only tests) — guard with != null so their behaviour is
            // unchanged; the live parse loop always passes the freshly-refreshed tip.
            if (nodeTip != null && lastBlockIndex > nodeTip){
                try {
                    await this.db.deleteBlockByIndex(lastBlockIndex)
                    retryCount = 0
                    blocksDeleted.push({"block_index":lastBlockIndex, "block_hash":lastBlock["block_hash"]})
                } catch (err){
                    console.error(`reorg: failed to delete above-tip block ${lastBlockIndex} (${lastBlock.block_hash}): `, err)
                    if (++retryCount >= 10) throw new Error('verifyReorg: deleteBlockByIndex failed after 10 attempts, aborting')
                    await this.sleep(3000)
                }
                continue
            }

            let blockHashFromNode
            try {
                blockHashFromNode = await this.connector.getBlockHash(lastBlockIndex)
            } catch (err){
                console.log("There was a problem trying to get a block hash from the node. Trying again...", err)
                await this.sleep(3000)
                continue
            }
            
            if (lastBlock["block_hash"] != blockHashFromNode){
                try {
                    await this.db.deleteBlockByIndex(lastBlockIndex)

                    // Per-block retry budget: reset after each successful delete so the
                    // 10-attempt limit applies per block, not cumulatively across the whole
                    // reorg run. Otherwise a multi-block reorg with one transient failure per
                    // block could exhaust the budget and abort, leaving orphan blocks behind.
                    retryCount = 0
                    blocksDeleted.push({"block_index":lastBlockIndex, "block_hash":lastBlock["block_hash"]})
                } catch (err){
                    console.error(`reorg: failed to delete block ${lastBlockIndex} (${lastBlock.block_hash}): `, err)
                    if (++retryCount >= 10) throw new Error('verifyReorg: deleteBlockByIndex failed after 10 attempts, aborting')
                    await this.sleep(3000); continue
                }
            } else {
                thereAreDifferences = false
            }
        }
        
        if (blocksDeleted.length > 0){
            // The REORG event is the only audit record of which blocks were rolled
            // back. insertEvent returns false on failure (e.g. the payload once
            // overflowed events.data TEXT — now MEDIUMTEXT) instead of throwing;
            // never drop it silently. Log loudly so the loss is visible to ops.
            const eventResult = await this.db.insertEvent("REORG", blocksDeleted)
            if (eventResult === false){
                console.error(`reorg: FAILED to persist REORG audit event for ${blocksDeleted.length} rolled-back block(s) — blocks deleted: ` + JSON.stringify(blocksDeleted.map(b => b.block_index)))
            }
        }

        return true
    }
    
    async start(){
        if (!this.db) {
            this.db = new Database(this.dbUrl, this.dbPort, this.dbName, this.dbUser, this.dbPassword)
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
            //previously-seen tip, OR periodically on a wall-clock interval — the
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

                    // The node's tip has dropped BELOW our last-processed height — a deep
                    // reorg, a node rollback, or a restart onto a shorter/different chain.
                    // The forward hash-compare reorg path (below) is unreachable in this
                    // state (it only fires when fetching a block ABOVE our height), so
                    // without this branch the decoder loops forever logging the gap while
                    // orphan blocks above the node tip survive — which the indexer then
                    // inherits (the P0 failure TP-17 exists to prevent). Reconcile now:
                    // verifyReorg(tip) deletes every stored block above the tip via a
                    // deterministic height compare, then walks the hash-compare back to
                    // the fork point. blockchainInfoLastBlock was just refreshed above, so
                    // the tip is current.
                    console.log("The last processed block height ("+lastProcessedBlockIndex+") is greater than the last block from the node ("+this.blockchainInfoLastBlock+"). Reconciling orphan blocks...")
                    await this.db.endTransaction()
                    await this.verifyReorg(this.blockchainInfoLastBlock)
                    lastProcessedBlockIndex = this.lastProcessedBlockIndex = await this.db.getLastBlockIndex()
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
            // TODO (residual, TP-17 F-9): an equal-height tip REPLACEMENT (the node
            // swaps its tip for a different block of the same height) is not detected
            // here — it surfaces only once the next block arrives and the forward
            // hash-compare fires. A tip-hash check in this branch would close that
            // narrow gap; left out for now to keep the synced/mempool path unchanged.
            if (lastProcessedBlockIndex == this.blockchainInfoLastBlock){
                this.synced = true
                if (this.mempoolInterval == null){
                    console.log("Mempool parsing started!")
                    this.updateMempool().catch(err => console.error('[updateMempool] unhandled error:', err))
                    this.mempoolInterval = setInterval(() => {
                        this.updateMempool().catch(err => console.error('[updateMempool] unhandled error:', err))
                    }, MEMPOOL_INTERVAL)
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
                try {
                    nextBlockHash = await this.connector.getBlockHash(nextBlockHeight)

                    if (this.auxPow) {
                        nextBlockHex = await this.connector.getBlockWithoutAuxPow(nextBlockHash)
                    } else {
                        nextBlockHex = await this.connector.getBlock(nextBlockHash)
                    }
                } catch (e){
                    console.error('Error fetching block at height ' + nextBlockHeight + ':', e)
                    await this.sleep(3000)
                    continue
                }
                
                // A throw here would otherwise escape start() and permanently stop the
                // decode loop (api.js only logs the rejection), wedging the pipeline at
                // this height. Never skip a whole block — a block we cannot decode is a
                // parser bug, not data to discard — but stay alive and keep retrying so
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
                    lastProcessedBlockIndex = this.lastProcessedBlockIndex = await this.db.getLastBlockIndex()
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
                    // Treat null as transient — retry this height — matching the
                    // block-fetch error path above.
                    if (!previousBlock){
                        console.error(`Could not load previous block ${nextBlockHeight - 1} for reorg check, retrying...`)
                        await this.sleep(3000)
                        continue
                    }

                    //previousBlockHash is not the same, it must be a reorg
                    if (previousBlockHash != previousBlock.block_hash){
                        await this.db.endTransaction()
                        console.log("A reorg has been detected. Cleaning blocks...")
                        await this.verifyReorg(this.blockchainInfoLastBlock)
                        lastProcessedBlockIndex = this.lastProcessedBlockIndex = await this.db.getLastBlockIndex()
                        lastProcessedTxIndex = await this.db.getLastTxIndex()
                        blocksQuantity = 0
                        transactionsCount = 0
                        validTransactionsCount = 0
                        outputCount = 0
                        startTimeStamp = Date.now()
                        console.log("Blocks were updated")
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
                    console.log("Error trying to insert a Block to the database")
                    await this.sleep(3000)
                    continue main_parsing
                }
                
                //Soft-expire open dispensers past their expiration (marks them with
                //this block height instead of deleting, so a reorg can restore them).
                await this.db.deleteOpenDispensers(nextBlockHeight, block.timestamp)

                // Load the set of open-dispenser addresses once for this block (after
                // expiring stale ones above) so parseTransaction can test each output
                // against it in JS instead of issuing one DB query per output — the
                // per-output lookup was thousands of serialized round-trips per mainnet
                // block. Kept current within the block by .add()ing any dispenser opened
                // by a transaction below, matching the previous per-output query timing.
                let openDispenserAddresses = await this.db.getAllOpenDispenserAddresses()

                //Loop through the transactions and saving only the ones that have valid data
                var transactions = block.transactions
                blocksCount = blocksCount + 1

                for (let txIndex=0;txIndex < transactions.length;txIndex++){
                    let nextTransaction = transactions[txIndex]
                    let nextTransactionHash = null
                    let parseResult = null
                    try {
                        nextTransactionHash = nextTransaction.getId()
                        parseResult = await this.parseTransaction(nextTransaction, openDispenserAddresses)
                    } catch (e){
                        if (txParseRetryHeight != nextBlockHeight){
                            txParseRetryHeight = nextBlockHeight
                            txParseRetryCount = 0
                        }
                        txParseRetryCount++

                        if (txParseRetryCount <= TX_PARSE_MAX_RETRIES){
                            // Could be transient (node RPC / DB hiccup inside parseTransaction):
                            // roll the block back and re-parse it from scratch.
                            console.error(`parseTransaction failed in block ${nextBlockHeight} (tx position ${txIndex}, attempt ${txParseRetryCount}/${TX_PARSE_MAX_RETRIES}), retrying block:`, e)
                            await this.db.endTransaction()
                            lastProcessedBlockIndex = this.lastProcessedBlockIndex = await this.db.getLastBlockIndex()
                            lastProcessedTxIndex = await this.db.getLastTxIndex()
                            blocksQuantity = 0
                            await this.sleep(3000)
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
                        })
                        if (eventResult === false){
                            // insertEvent already rolled the block transaction back
                            await this.sleep(3000)
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
                                if (parseResult["compiledDataLength"] > MAX_ACTION_DATA_LENGTH) {
                                    this.parseErrors++
                                    console.error(`Skipping tx ${nextTransactionHash}: ACTION data exceeds maximum length (${parseResult["compiledDataLength"]} > ${MAX_ACTION_DATA_LENGTH})`)
                                    continue
                                }

                                try {
                                    decodedData = strictTextDecoder.decode(parseResult["data"])
                                } catch (e) {
                                    this.parseErrors++
                                    decodedData = lenientTextDecoder.decode(parseResult["data"])
                                    console.error(`Tx ${nextTransactionHash}: ACTION data contains invalid UTF-8, decoded with replacement characters`, e)
                                }

                                let actionParts = decodedData.split("|")
                                let rawActionName = actionParts[0]
                                let actionName = ACTION_ALIASES[rawActionName] ?? rawActionName
                                if (!VALID_ACTION_NAMES.has(actionName)) {
                                    this.parseErrors++
                                    console.error(`Skipping tx ${nextTransactionHash}: unknown ACTION name '${rawActionName.substring(0, 32)}'`)
                                    continue
                                }
                                if (actionName !== rawActionName) {
                                    // Persist the canonical name so the DB is alias-free and
                                    // identical regardless of which spelling was used on-chain.
                                    actionParts[0] = actionName
                                    decodedData = actionParts.join("|")
                                }
                            }
                            
                            if (!(await this.db.insertTransaction({
                                index: lastProcessedTxIndex,
                                hash: nextTransactionHash,
                                block_index: nextBlockHeight,
                                source: parseResult["source"],
                                destination: parseResult["destination"],
                                amount: parseResult["amount"],
                                fee: 0,
                                data: decodedData,
                                raw_data: parseResult["rawData"] || null

                            }))){
                                await this.sleep(3000)
                                continue main_parsing
                            } else {
                                //Store dispenses outputs
                                for (let nextOutput of dispenseOutputs){
                                    nextOutput.txIndex = lastProcessedTxIndex
                                    let insertResult = await this.db.insertTransactionOutput(
                                        nextOutput
                                    )
                                    if (insertResult === this.db.DUPLICATED_TRANSACTION){
                                        console.warn(`Duplicate transaction_output on insert (block_index=${nextBlockHeight}, tx_index=${lastProcessedTxIndex}, vout=${nextOutput.vout}) — possible stale pre-reorg row not cleaned up by deleteBlockByIndex`)
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
                                        if (insertResult === this.db.DUPLICATED_TRANSACTION){
                                            console.warn(`Duplicate transaction_output on insert (block_index=${nextBlockHeight}, tx_index=${lastProcessedTxIndex}, vout=${nextOutput.vout}) — possible stale pre-reorg row not cleaned up by deleteBlockByIndex`)
                                        }
                                    }
                                }
                                
                                //Catch any dispenser message to add it to
                                //the list of possible dispenses.
                                //
                                //v0 wire format (must stay in sync with the
                                //indexer — see xchain-indexer/src/actions/dispenser.js):
                                //  DISPENSER|0|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT
                                //    |GIVE_OWNERSHIP|GIVE_ESCROW
                                //    |GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS
                                //    |FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS
                                //    |EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
                                if (decodedData.startsWith("DISPENSER")){
                                    let decodedDataSplit = decodedData.split("|")
                                    let commandVersion = decodedDataSplit[1]

                                    if (parseInt(commandVersion, 10) === 0 && decodedDataSplit.length >= 15){
                                        let giveCoin = decodedDataSplit[2]
                                        let getCoin = decodedDataSplit[7]
                                        let getAddress = decodedDataSplit[10]
                                        let expiration = Number(decodedDataSplit[14])

                                        if (isNaN(expiration) || expiration < 0 || expiration > 4294967295) {
                                            this.parseErrors++
                                            console.error(`Skipping dispenser in tx ${nextTransactionHash}: invalid expiration value '${decodedDataSplit[14]}'`)
                                        } else if ((getCoin != "") || (giveCoin != "")){
                                            if (!(await this.db.insertDispenser({
                                                txIndex: lastProcessedTxIndex,
                                                address: parseResult["source"],
                                                expiration: expiration
                                            }))){
                                                await this.sleep(3000)
                                                continue main_parsing
                                            }
                                            // Keep the in-memory open-dispenser set current so a
                                            // later transaction in this same block that pays this
                                            // freshly-opened dispenser is still recognized as a
                                            // dispense (mirrors the old per-output DB lookup).
                                            if (parseResult["source"])
                                                openDispenserAddresses.add(parseResult["source"])
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
                    await this.db.commitTransaction()

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

                for (let nextUnorderedItemIndex in rawMempoolUnordered) {
                    let nextUnorderedItem = rawMempoolUnordered[nextUnorderedItemIndex]

                    let newIndex = bs(rawMempool, nextUnorderedItem, function (element, needle) { return needle.localeCompare(element) })

                    if (newIndex < 0) {
                        rawMempool.splice(-newIndex - 1, 0, nextUnorderedItem)
                    }
                }



            } catch (error) {
                console.log(error)
                console.log("There were problems getting the mempool, trying again later.", error)
                this.mempoolBusy = false
                return
            }

            //let transactionsCount = 0
            let validTransactionsCount = 0

            try {
            //await this.mempoolDb.beginTransaction()
            //This deletes the txs that are in the database but not longer in the mempool. Also, it removes
            //the transactions that already exist in the database, leaving rawMempool only with the new transactions from the mempool
            let deletedInfo = await this.db.deleteAndCompareTxsNotInList(rawMempool)

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
                        parseResult = await this.parseTransaction(nextTx)
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
                        // Mirror the confirmed-block path: gate mempool entries on the
                        // ACTION-name allowlist (expanding aliases first) so an alias-named
                        // tx can't show as pending and then silently vanish when it confirms.
                        let pipeIndex = mempoolData.indexOf(0x7C) // '|'
                        let nameEnd = pipeIndex === -1 ? mempoolData.length : pipeIndex
                        let rawActionName = lenientTextDecoder.decode(mempoolData.subarray(0, nameEnd))
                        let actionName = ACTION_ALIASES[rawActionName] ?? rawActionName
                        if (!VALID_ACTION_NAMES.has(actionName)) {
                            this.parseErrors++
                            console.error(`Mempool: skipping tx ${nextTransactionHash}: unknown ACTION name '${rawActionName.substring(0, 32)}'`)
                            continue
                        }
                        if (actionName !== rawActionName) {
                            // Rewrite only the leading name bytes to the canonical spelling;
                            // splicing at the first '|' preserves any binary payload verbatim.
                            mempoolData = Buffer.concat([
                                Buffer.from(actionName, 'ascii'),
                                Buffer.from(mempoolData.subarray(nameEnd))
                            ])
                        }
                    }

                    if (!(await this.db.insertMempoolTransaction({
                        hash: nextTransactionHash,
                        source: parseResult["source"],
                        destination: parseResult["destination"],
                        amount: parseResult["amount"],
                        fee: 0,
                        data: (mempoolData != null ? util.uint8ArrayToHex(mempoolData) : null)

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

            //await this.mempoolDb.endTransaction()
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