const dotenv = require('dotenv')
dotenv.config()

const { execSync } = require('child_process');
const nodeHelper = require('./nodeHelper')
const XChainDecoder  = require('../src/XChainDecoder');
const Database = require('../src/db.js')


const NETWORK = process.env.NETWORK
const NODE_URL =  process.env.NODE_URL
const NODE_USER =  process.env.NODE_USER
const NODE_PASSWORD =  process.env.NODE_PASSWORD
const DB_URL =  process.env.DB_URL
const DB_PORT =  process.env.DB_PORT
const DB_NAME =  process.env.DB_NAME
const DB_USER =  process.env.DB_USER
const DB_PASSWORD =  process.env.DB_PASSWORD

var decoder = null

// Función para ejecutar comandos del sistema
function executeCommand(comando) {
  let options = {stdio : 'pipe' };
  return execSync(comando, options);
}

function checkNode(){
  try {
    // Obtener la información de la red utilizando bitcoin-cli
    const networkInfo = executeCommand('bitcoin-cli -regtest getnetworkinfo');

	// Analizar la salida para verificar si el nodo regtest está en ejecución
    const parsedNetworkInfo = JSON.parse(networkInfo);
    return parsedNetworkInfo.networkactive === true;
  } catch (error) {
    // Manejar errores si es necesario
	return false
  }
}

// Función para esperar un tiempo específico
function wait(ms) {
  return new Promise((resolver) => setTimeout(resolver, ms));
}

exports.mochaHooks = {
   async beforeAll(){
	 console.log("Starting the decoder")
	 //Prepare the database	 
	 db = new Database(DB_URL, DB_PORT, DB_NAME+'_regtest', DB_USER, DB_PASSWORD)
	 await db.dropDatabase()

	 //Prepare the decoder
	 decoder = new XChainDecoder(NETWORK, DB_URL, DB_PORT, DB_NAME+'_regtest', DB_USER, DB_PASSWORD, NODE_URL, NODE_USER, NODE_PASSWORD);
	 
	 if (checkNode()){
	   // Stop regtest node
       console.log("Stopping node")
       executeCommand('bitcoin-cli -regtest stop');
	 } else {
	   console.log("The node is not working, continuing execution")
	   //Assuming regtest node is not executing
	 }

     // Limpiar la cadena de bloques y los datos del nodo regtest (opcional)
	 console.log("Cleaning node")
     executeCommand('rm -rf ~/.bitcoin/regtest');

     // Inicializar el nodo regtest
     console.log("Restarting node")
     executeCommand('bitcoind -regtest -daemon -fallbackfee=1.0 -maxtxfee=1.1');

     console.log("Checking node")
	 await wait(1000)
     while (!checkNode()){
		 console.log("Node is not ready yet, waiting 5 seconds")
		 await wait(5000)
	 }

    // Puedes realizar más acciones después de reiniciar el nodo si es necesario
    console.log('Nodo regtest reset and ready.');
	
	console.log("Creating the wallet 'test-wallet'")
	nodeClientTest = await nodeHelper.getWalletConnection('test-wallet') 
	
	console.log("Obtaining an address")
	global.mainTestAddress = await nodeClientTest.getNewAddress()
	console.log("The address obtained is "+mainTestAddress+". Generating blocks.")
	await nodeClientTest.generateToAddress(101, mainTestAddress)
	console.log("Obtaining balance")
	let balance = await nodeClientTest.getBalance()
	console.log("The address "+mainTestAddress+" has "+balance+" BTC")
	
	
	decoder.start()
  },
  
  async afterAll(){
	  decoder.stop()
  }
}
