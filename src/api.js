/*********************************************************************
 * 
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 * 
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided “AS IS”, without warranties or conditions of any kind.
 * 
 **********************************************************************
 *
 * XChain Decoder - API
 * 
 * This file parses in environmental variables and starts up the decoder instance
 * 
 ********************************************************************/

// Load required libraries
const dotenv = require('dotenv')
dotenv.config()


const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const XChainDecoder  = require('./XChainDecoder');
const jsonRouter = require('express-json-rpc-router')


const NETWORK = process.env.NETWORK
const NODE_URL =  process.env.NODE_URL
const NODE_PORT =  process.env.NODE_PORT
const NODE_USER =  process.env.NODE_USER
const NODE_PASSWORD =  process.env.NODE_PASSWORD
const DB_URL =  process.env.DECODER_DB_HOST
const DB_PORT =  process.env.DECODER_DB_PORT
const DECODER_DB_NAME =  process.env.DECODER_DB_NAME
const DECODER_DB_USER =  process.env.DECODER_DB_USER
const DB_PASSWORD =  process.env.DECODER_DB_PASS
const DECODER_API_PORT = process.env.DECODER_API_PORT
const AUX_POW = process.env.AUX_POW

async function startApi(){
    //Start the indexer
    const decoder = new XChainDecoder(NETWORK, DB_URL, DB_PORT, DECODER_DB_NAME, DECODER_DB_USER, DB_PASSWORD, NODE_URL, NODE_PORT, NODE_USER, NODE_PASSWORD, AUX_POW);
    let decoderRunning = true
    let decoderError = null
    decoder.start().catch((err) => {
        console.error('Decoder crashed:', err)
        decoderRunning = false
        decoderError = err
    })

    // Graceful shutdown on process signals
    const shutdown = () => {
        console.log('Received shutdown signal, stopping decoder...')
        decoder.stop()
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)

    process.on('unhandledRejection', (reason) => {
        console.error('Unhandled promise rejection:', reason)
    })

    // Create the app
    const app = express();

    // Use Helmet to increase security
    app.use(helmet());

    // Rate limiting (requests per minute per IP; override with DECODER_RATE_LIMIT_RPM)
    app.use(rateLimit({
        windowMs: 60 * 1000,
        limit: parseInt(process.env.DECODER_RATE_LIMIT_RPM, 10) || 100,
        standardHeaders: true,
        legacyHeaders: false
    }));

    // Allow JSON requests with size limit
    app.use(bodyParser.json({ limit: '100kb' }));

    // Allow CORS for development
    app.use(cors());


    const jsonRpcController = {
        // Function to check if xchain-decoder is up
        async ping() {
            return {status:"success"};
        },
        // Health check that reports actual decoder state
        async health() {
            const syncStatus = decoder.getSyncStatus();
            return {
                status: decoderRunning ? "healthy" : "unhealthy",
                synced: decoder.isSynced(),
                ...syncStatus,
                lastProcessedBlock: syncStatus.last_processed_block,
                chainTipBlock: syncStatus.node_height,
                blockLag: syncStatus.lag,
                lag_blocks: Math.max(0, (decoder.blockchainInfoLastBlock || 0) - (decoder.lastProcessedBlockIndex || 0)),
                rpc_errors: decoder.rpcErrors + decoder.connector.rpcErrors,
                parse_errors: decoder.parseErrors,
                error: decoderError ? decoderError.message : null
            }
        },
        // Latest decoded block index alongside the coin-node's tip so the
        // decoder→node lag is visible in a single call.
        async getlatestblock() {
            let status = decoder.getSyncStatus();
            return {
                block_index:      status.last_processed_block,
                node_block_index: status.node_height,
                is_synced:        decoder.isSynced()
            };
        }
    }

    // Allow JSON-RPC requests
    app.use(jsonRouter({methods: jsonRpcController}))


    // Start the server
    app.listen(DECODER_API_PORT, () => {
      console.log('API listening on port '+DECODER_API_PORT);
    });
}

startApi()