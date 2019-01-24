const fs = require('fs')
const cp = require('child_process')
const constants = require('./constants.js')
const defer = require('./utils.js').defer
const jsonrpc = require('./utils.js').jsonrpc
const express = require('express')
const bodyParser = require('body-parser')
const log = require('debug')('info:api-app')
const EthService = require('./eth-service.js')
const appRoot = require('app-root-path')
const BN = require('web3').utils.BN

// Set up express
const app = express()
// Set up child processes
let stateManager
let blockManager
let started = false
const alreadyStartedError = new Error('Operator already started!')

app.use(bodyParser.json())

// Setup simple message queue
const messageQueue = {}
let messageCounter = 0

function sendMessage (process, message) {
  const deferred = defer()
  process.send({
    ipcID: messageCounter,
    message
  })
  messageQueue[messageCounter] = { resolve: deferred.resolve }
  messageCounter++
  return deferred.promise
}

function resolveMessage (m) {
  log('Resolving message with ipcID', m.ipcID)
  messageQueue[m.ipcID].resolve(m)
  delete messageQueue[m.ipcID]
}

// Handle incoming transactions
app.post('/api', function (req, res) {
  log('INCOMING RPC request with method:', req.body.method, 'and rpcID:', req.body.id)
  if (req.body.method === constants.DEPOSIT_METHOD ||
      req.body.method === constants.ADD_TX_METHOD ||
      req.body.method === constants.NEW_BLOCK_METHOD) {
    sendMessage(stateManager, req.body).then((response) => {
      log('OUTGOING response to RPC request with method:', req.body.method, 'and rpcID:', req.body.id)
      res.send(response.message)
    })
  } else if (req.body.method === 'NOT YET IMPLEMENTED') {
    sendMessage(blockManager, req.body).then((response) => {
      res.send('POST request success from block manager')
    })
  }
})

async function startup (config) {
  if (started) {
    throw alreadyStartedError
  }
  // Begin listening for connections
  // Make a new db directory if it doesn't exist.
  if (!fs.existsSync(config.dbDir)) {
    log('Creating a new db directory because it does not exist')
    fs.mkdirSync(config.dbDir)
    fs.mkdirSync(config.ethDBDir)
  }
  try {
    // Setup web3
    await EthService.startup(config)
    // Setup our child processes -- stateManager & blockManager
    stateManager = cp.fork(appRoot + '/src/state-manager/app.js')
    blockManager = cp.fork(appRoot + '/src/block-manager/app.js')
    stateManager.on('message', resolveMessage)
    blockManager.on('message', resolveMessage)
    // Now send an init message
    await sendMessage(stateManager, jsonrpc(constants.INIT_METHOD, {
      stateDBDir: config.stateDBDir,
      txLogDir: config.txLogDir
    }))
    await sendMessage(blockManager, jsonrpc(constants.INIT_METHOD, {
      blockDBDir: config.blockDBDir,
      txLogDir: config.txLogDir
    }))
    // Set up the eth event watchers
    log('Registering Ethereum event watcher for `DepositEvent(address,uint256)`')
    EthService.eventWatchers['DepositEvent(address,uint256,uint256,uint256)'].subscribe(_submitDeposits)
  } catch (err) {
    throw err
  }
  log('Finished sub process startup')
  app.listen(config.port, () => {
    console.log('\x1b[36m%s\x1b[0m', `Operator listening on port ${config.port}!`)
  })
  started = true
}

// Startup that will only run once
async function safeStartup (config) {
  try {
    await startup(config)
  } catch (err) {
    if (err !== alreadyStartedError) {
      // If this error is anything other than an already started error, throw it
      throw err
    }
    log('Startup has already been run... skipping...')
  }
}

async function _submitDeposits (err, depositEvents) {
  if (err) {
    throw err
  }
  for (const e of depositEvents) {
    // Decode the event...
    const depositEvent = e.returnValues
    const recipient = depositEvent.depositer
    const token = new BN(depositEvent.start).toArrayLike(Buffer, 'big', 16).slice(0, 4)
    const start = new BN(depositEvent.start).toArrayLike(Buffer, 'big', 16).slice(4)
    const end = new BN(depositEvent.end).toArrayLike(Buffer, 'big', 16).slice(4)
    // Send the deposit to the state manager
    await sendMessage(stateManager, jsonrpc(constants.DEPOSIT_METHOD, {
      id: e.id,
      recipient,
      token,
      start,
      end
    }))
  }
}

module.exports = {
  app,
  startup,
  safeStartup
}
