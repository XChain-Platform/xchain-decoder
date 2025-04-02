const dotenv = require('dotenv')
dotenv.config()


const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const cors = require('cors');
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
	decoder.start()

	// Create the app
	const app = express();

	// Use Helmet to increase security
	app.use(helmet());

	// Allow JSON requests
	app.use(bodyParser.json());

	// Allow CORS for development
	app.use(cors());


	const jsonRpcController = {
		/*
		// Function to create transactions hex for a given data and encoding type
		async getValidTransactions({blockIndex}) {
			
		}*/
	}

	// Allow JSON-RPC requests
	app.use(jsonRouter({methods: jsonRpcController}))


	// Start the server
	app.listen(DECODER_API_PORT, () => {
	  console.log('API listening on port '+DECODER_API_PORT);
	});
}

startApi()