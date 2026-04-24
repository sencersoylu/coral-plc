const net = require('net');
require('dotenv').config();
const express = require('express');

const app = express();
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

const { Chance } = require('chance');
const chance = new Chance();

const demo = 0;

const connections = []; // view soket bağlantılarının tutulduğu array
let isConnectedPLC = 0;

const sensorData = [];

// Persistent PLC connection state
let plcClient = null;
let plcConnecting = false;
let plcReconnectTimer = null;
let rxBuffer = Buffer.alloc(0);
const requestQueue = [];
let inFlightTimer = null;
const PLC_RESPONSE_TIMEOUT_MS = 1000;
const PLC_RECONNECT_DELAY_MS = 2000;

// Seat & Operator Registry for call system
const seatSockets = new Map();     // seatNumber → socket
const operatorSockets = new Map(); // socketId → socket
const activeCalls = new Map();     // callId → { callId, callerSocket, calleeSocket, startTime }

// *****************************************
// *****************************************
// *****************************************
// CONFIG
// *****************************************
// *****************************************
// *****************************************

const { COMPANY } = process.env;
const { PLC_IP } = process.env;
const { PLC_PORT } = process.env;

// *****************************************
// *****************************************
// *****************************************
// Database
// *****************************************
// *****************************************
// *****************************************
//const db = require('./src/models');

// db.sequelize.sync();

// *****************************************
// *****************************************
// *****************************************
// STARTUP
// *****************************************
// *****************************************
// *****************************************
init();
const allRoutes = require('./src/routes');

app.use(allRoutes);

if (demo == 0) {
	connectPLC();
}

// *****************************************
// *****************************************
// *****************************************
// FUNCTIONS
// *****************************************
// *****************************************
// *****************************************

async function sendMessage() {
	io.sockets.emit(
		'data',
		JSON.stringify({
			isConnectedPLC,
			data: sensorData,
		})
	);
}
async function init() {
	console.log('**************** APP START ****************');
	app.use(express.json());
	app.use(express.urlencoded({ extended: true }));
	app.use(cors());

	try {
		// Removed commented service code
	} catch (err) {
		console.log(err);
	}
}

function calculateLRC(buf) {
	let lrc = 0;
	for (let i = 0; i < buf.length; i++) {
		lrc += buf[i];
	}
	return (lrc & 0xff).toString(16).padStart(2, '0');
}

function scheduleReconnect() {
	if (plcReconnectTimer) return;
	plcReconnectTimer = setTimeout(() => {
		plcReconnectTimer = null;
		connectPLC();
	}, PLC_RECONNECT_DELAY_MS);
}

function teardownPLC(reason) {
	if (plcClient) {
		try { plcClient.destroy(); } catch (e) {}
		plcClient = null;
	}
	plcConnecting = false;
	rxBuffer = Buffer.alloc(0);
	if (inFlightTimer) {
		clearTimeout(inFlightTimer);
		inFlightTimer = null;
	}
	if (isConnectedPLC !== 2) {
		isConnectedPLC = 2;
		sendMessage();
	}
	console.log(`PLC connection down: ${reason}`);
	scheduleReconnect();
}

function connectPLC() {
	if (plcClient || plcConnecting) return;
	plcConnecting = true;

	const host = PLC_IP || '192.168.77.3';
	const port = parseInt(PLC_PORT, 10) || 500;

	const client = new net.Socket();
	client.setKeepAlive(true, 10000);
	client.setNoDelay(true);

	client.once('ready', () => {
		plcConnecting = false;
		plcClient = client;
		rxBuffer = Buffer.alloc(0);
		isConnectedPLC = 1;
		sendMessage();
		console.log(`PLC connected ${host}:${port}`);
		// Drain anything queued during downtime
		processQueue();
	});

	client.on('error', (err) => {
		console.log('PLC socket error:', err.message);
		// 'close' will follow; teardown there
	});

	client.on('close', () => {
		teardownPLC('socket closed');
	});

	client.on('data', (chunk) => {
		rxBuffer = Buffer.concat([rxBuffer, chunk]);
		// Frame by STX(0x02) ... ETX(0x03)
		while (true) {
			const stx = rxBuffer.indexOf(0x02);
			if (stx === -1) {
				rxBuffer = Buffer.alloc(0);
				break;
			}
			if (stx > 0) rxBuffer = rxBuffer.slice(stx);
			const etx = rxBuffer.indexOf(0x03);
			if (etx === -1) break; // wait for more bytes
			const frame = rxBuffer.slice(0, etx + 1);
			rxBuffer = rxBuffer.slice(etx + 1);
			handleFrame(frame);
			onResponseReceived();
		}
	});

	client.connect(port, host);
}

function handleFrame(data) {
	try {
		const head = data.slice(0, 4);
		if (Buffer.compare(head, Buffer.from([0x02, 0x30, 0x31, 0x34])) !== 0) {
			return; // not a register-read response we care about
		}
		const buff = data.slice(6, data.length - 3);
		const size = Math.floor(buff.length / 4);
		for (let index = 0; index < size; index++) {
			sensorData[index] = parseInt(
				buff.slice(index * 4, index * 4 + 4).toString('ascii'),
				16
			);
		}
		sendMessage();
	} catch (error) {
		console.log('Frame parse error:', error);
	}
}

function enqueuePLC(buf, label) {
	requestQueue.push({ buf, label: label || 'req' });
	processQueue();
}

function processQueue() {
	if (inFlightTimer) return; // waiting for a response
	if (!plcClient || isConnectedPLC !== 1) return;
	if (requestQueue.length === 0) return;

	const { buf, label } = requestQueue.shift();
	try {
		plcClient.write(buf);
	} catch (e) {
		console.log(`PLC write error (${label}):`, e.message);
		teardownPLC('write failed');
		return;
	}

	inFlightTimer = setTimeout(() => {
		inFlightTimer = null;
		console.log(`PLC response timeout (${label})`);
		teardownPLC('response timeout');
	}, PLC_RESPONSE_TIMEOUT_MS);
}

function onResponseReceived() {
	if (inFlightTimer) {
		clearTimeout(inFlightTimer);
		inFlightTimer = null;
	}
	processQueue();
}

function d2h(d) {
	return ('0000' + (+d).toString(16)).slice(-4);
}

async function writeBit(registerAdress, value) {
	const buf1 = Buffer.from(
		[
			0x02,
			'0'.charCodeAt(),
			'1'.charCodeAt(),
			'4'.charCodeAt(),
			'5'.charCodeAt(),
			'0'.charCodeAt(),
			'1'.charCodeAt(),
		],
		'ascii'
	);

	const buf2 = Buffer.from(registerAdress, parseInt(value));
	let buf3;
	if (value == 0) buf3 = Buffer.from([0x30]);
	else buf3 = Buffer.from([0x31]);

	const bufA = Buffer.concat(
		[buf1, buf2, buf3],
		buf1.length + buf2.length + buf3.length
	);

	const LRC = calculateLRC(bufA);

	console.log(LRC);

	const bufB = Buffer.concat([
		bufA,
		Buffer.from([LRC[0].charCodeAt(), LRC[1].charCodeAt(), 0x03]),
	]);

	console.log(bufB);
	return bufB;
}

async function writeData(registerAdress, value) {
	const buf1 = Buffer.from(
		[
			0x02,
			'0'.charCodeAt(),
			'1'.charCodeAt(),
			'4'.charCodeAt(),
			'7'.charCodeAt(),
			'0'.charCodeAt(),
			'1'.charCodeAt(),
		],
		'ascii'
	);

	const buf2 = Buffer.from(registerAdress, parseInt(value));
	var buf3 = Buffer.from(d2h(parseInt(value)).toUpperCase(), 'ascii');

	const bufA = Buffer.concat(
		[buf1, buf2, buf3],
		buf1.length + buf2.length + buf3.length
	);

	const LRC = calculateLRC(bufA);

	console.log(LRC);

	const bufB = Buffer.concat([
		bufA,
		Buffer.from([LRC[0].charCodeAt(), LRC[1].charCodeAt(), 0x03]),
	]);

	console.log(bufB);
	return bufB;
}

async function writeMultipleData(startRegisterAddress, values) {
	// values should be an array of values to write to continuous registers
	const numValues = values.length;

	// Convert number to 2-character hex string for NUM field
	const numHex = numValues.toString(16).padStart(2, '0').toUpperCase();

	const buf1 = Buffer.from(
		[
			0x02,
			'0'.charCodeAt(),
			'1'.charCodeAt(),
			'4'.charCodeAt(),
			'7'.charCodeAt(),
			numHex[0].charCodeAt(),
			numHex[1].charCodeAt(),
		],
		'ascii'
	);

	// Register address buffer
	const buf2 = Buffer.from(startRegisterAddress, 'ascii');

	// Create buffers for all values
	const valueBuffers = [];
	for (let i = 0; i < values.length; i++) {
		const valueHex = d2h(parseInt(values[i])).toUpperCase();
		valueBuffers.push(Buffer.from(valueHex, 'ascii'));
	}

	// Concatenate all value buffers
	const buf3 = Buffer.concat(valueBuffers);

	const bufA = Buffer.concat(
		[buf1, buf2, buf3],
		buf1.length + buf2.length + buf3.length
	);

	const LRC = calculateLRC(bufA);

	console.log(`LRC: ${LRC}`);
	console.log(
		`Writing ${numValues} values starting at ${startRegisterAddress}:`,
		values
	);

	const bufB = Buffer.concat([
		bufA,
		Buffer.from([LRC[0].charCodeAt(), LRC[1].charCodeAt(), 0x03]),
	]);

	console.log('Complete buffer:', bufB);
	return bufB;
}

// *****************************************
// *****************************************
// *****************************************
// INTERVALS
// *****************************************
// *****************************************
// *****************************************

function buildReadRequest() {
	const buf1 = Buffer.from(
		[
			0x02,
			'0'.charCodeAt(),
			'1'.charCodeAt(),
			'4'.charCodeAt(),
			'6'.charCodeAt(),
			'1'.charCodeAt(),
			'3'.charCodeAt(),
		],
		'ascii'
	);
	const buf2 = Buffer.from('R02000');
	const bufA = Buffer.concat([buf1, buf2], buf1.length + buf2.length);
	const LRC = calculateLRC(bufA);
	return Buffer.concat([
		bufA,
		Buffer.from([LRC[0].charCodeAt(), LRC[1].charCodeAt(), 0x03]),
	]);
}

setInterval(async () => {
	if (demo == 0) {
		// Drop poll if already busy / queue building up — keeps us in sync with PLC cadence
		if (inFlightTimer || requestQueue.length > 0) return;
		enqueuePLC(buildReadRequest(), 'poll');
	} else {
		console.log('demo mode');
		io.emit(
			'data',
			JSON.stringify({
				isConnectedPLC: 1,
				data: [
					chance.integer({ min: 2500, max: 16383 }),
					chance.integer({ min: 2500, max: 16383 }),
					chance.integer({ min: 2500, max: 16383 }),
					chance.integer({ min: 2500, max: 16383 }),
					chance.integer({ min: 2500, max: 16383 }),
					chance.integer({ min: 2500, max: 16383 }),
					chance.integer({ min: 2500, max: 16383 }),
					chance.integer({ min: 2500, max: 16383 }),
					chance.integer({ min: 2500, max: 16383 }),
					chance.integer({ min: 2500, max: 16383 }),
					0,
					chance.integer({ min: 2500, max: 16383 }),
					chance.integer({ min: 2500, max: 16383 }),
					chance.integer({ min: 2500, max: 16383 }),
					chance.integer({ min: 2500, max: 16383 }),
					chance.integer({ min: 2500, max: 16383 }),
					chance.integer({ min: 2500, max: 16383 }),
					chance.integer({ min: 2500, max: 16383 }),
					chance.integer({ min: 2500, max: 16383 }),
				],
			})
		);
	}
}, 1000);

// Add a simple health check endpoint
app.get('/health', (req, res) => {
	res.json({
		status: 'ok',
		timestamp: new Date().toISOString(),
		connections: connections.length,
		isConnectedPLC,
		server: 'Socket.IO Server v4.7.5',
	});
});

// *****************************************
// *****************************************
// CALL SYSTEM HELPERS
// *****************************************
// *****************************************

function getSeatList() {
	const seats = [];
	seatSockets.forEach((sock, seatNumber) => {
		seats.push({
			seatNumber,
			online: sock.connected,
			inCall: !!sock.currentCallId,
		});
	});
	return seats;
}

function broadcastSeatList() {
	const seats = getSeatList();
	operatorSockets.forEach((sock) => {
		if (sock.connected) {
			sock.emit('seat:list', { seats });
		}
	});
}

function resolveTarget(target) {
	if (target === 'operator') {
		// Return first connected operator not in a call
		for (const [, sock] of operatorSockets) {
			if (sock.connected && !sock.currentCallId) return sock;
		}
		return null;
	}

	// 'seat-3' format
	const match = target.match(/^seat-(\d+)$/);
	if (match) {
		const seatNum = parseInt(match[1], 10);
		const sock = seatSockets.get(seatNum);
		return sock?.connected ? sock : null;
	}

	return null;
}

function isInCall(socket) {
	return !!socket.currentCallId && activeCalls.has(socket.currentCallId);
}

function endCallForSocket(socket) {
	const callId = socket.currentCallId;
	if (!callId) return;

	const call = activeCalls.get(callId);
	if (!call) return;

	// Notify the other party
	const other = call.callerSocket === socket ? call.calleeSocket : call.callerSocket;
	if (other?.connected) {
		other.emit('call:ended', {});
		other.currentCallId = null;
	}

	socket.currentCallId = null;
	cleanupCall(callId);
}

function cleanupCall(callId) {
	const call = activeCalls.get(callId);
	if (call) {
		if (call.callerSocket) call.callerSocket.currentCallId = null;
		if (call.calleeSocket) call.calleeSocket.currentCallId = null;
		activeCalls.delete(callId);
	}
	broadcastSeatList();
}

// ***********************************************************
// ***********************************************************
// SERVER CONFIGS
// ***********************************************************
// ***********************************************************
const server = http.Server(app);
server.listen(4000, '0.0.0.0', () => {
	console.log('Listening on port 4000');
	console.log('Server available at:');
	console.log('- Local: http://localhost:4000');
	console.log('- Network: http://0.0.0.0:4000');
	console.log('- Health check: http://localhost:4000/health');
});

// ***********************************************************
// ***********************************************************
// IO CONFIGS
// ***********************************************************
// ***********************************************************
let io = socketIO(server, {
	cors: {
		origin: '*',
		methods: ['GET', 'POST'],
		allowedHeaders: ['my-custom-header'],
		credentials: true,
	},
	allowEIO3: true,
	transports: ['websocket', 'polling'],
	pingTimeout: 60000,
	pingInterval: 25000,
	upgradeTimeout: 30000,
	maxHttpBufferSize: 1e6,
});

// Add connection event handlers
io.engine.on('initial_headers', (headers, req) => {
	headers['test'] = '123';
	headers['set-cookie'] = 'mycookie=456';
});

io.engine.on('headers', (headers, req) => {
	headers['test'] = '789';
});

io.on('connect_error', (err) => {
	console.log('Socket.IO connect_error:', err);
});

io.sockets.on('connection', (socket) => {
	connections.push(socket);
	console.log(
		`Socket connected: ${socket.id}, Total connections: ${connections.length}`
	);
	console.log('Client transport:', socket.conn.transport.name);
	sendMessage();

	socket.on('sensorData', (msg) => {
		//console.log(msg);
		io.emit('sensorData', JSON.stringify(msg));
	});

	socket.on('sessionStart', (msg) => {
		console.log(msg);
		io.emit('sessionStart', JSON.stringify(msg));
	});

	socket.on('chamberControl', (msg) => {
		console.log(msg);
		io.emit('chamberControl', msg);
	});

	socket.on('patientData', (msg) => {
		//console.log(msg);
		io.emit('patientData', msg);
	});

	socket.on('sessionProfile', (msg) => {
		io.emit('sessionProfile', msg);
	});

	socket.on('requestSessionProfile', (msg) => {
		io.emit('requestSessionProfile', msg);
	});

	socket.on('disconnect', (reason) => {
		connections.splice(connections.indexOf(socket), 1);
		console.log(
			`Socket disconnected: ${socket.id}, Reason: ${reason}, Remaining connections: ${connections.length}`
		);

		// Seat/operator cleanup
		if (socket.role === 'seat' && socket.seatNumber != null) {
			seatSockets.delete(socket.seatNumber);
			endCallForSocket(socket);
			broadcastSeatList();
			console.log(`Seat ${socket.seatNumber} unregistered (disconnect)`);
		}
		if (socket.role === 'operator') {
			operatorSockets.delete(socket.id);
			endCallForSocket(socket);
			console.log(`Operator ${socket.id} unregistered (disconnect)`);
		}
	});

	socket.on('error', (error) => {
		console.log(`Socket error for ${socket.id}:`, error);
	});

	socket.on('connect_error', (error) => {
		console.log(`Socket connect_error for ${socket.id}:`, error);
	});

	// *****************************************
	// SEAT & OPERATOR REGISTRATION
	// *****************************************

	socket.on('seat:register', ({ seatNumber }) => {
		seatSockets.set(seatNumber, socket);
		socket.seatNumber = seatNumber;
		socket.role = 'seat';
		console.log(`Seat ${seatNumber} registered: ${socket.id}`);
		broadcastSeatList();
	});

	socket.on('operator:register', () => {
		operatorSockets.set(socket.id, socket);
		socket.role = 'operator';
		console.log(`Operator registered: ${socket.id}`);
		socket.emit('seat:list', { seats: getSeatList() });
	});

	// *****************************************
	// CALL ROUTING
	// *****************************************

	socket.on('call:initiate', ({ target }) => {
		const targetSocket = resolveTarget(target);

		if (!targetSocket) {
			socket.emit('call:error', { message: 'Target offline' });
			return;
		}

		if (isInCall(targetSocket)) {
			socket.emit('call:busy', {});
			return;
		}

		const callId = `call-${Date.now()}`;
		activeCalls.set(callId, {
			callId,
			callerSocket: socket,
			calleeSocket: targetSocket,
			startTime: null,
		});

		socket.currentCallId = callId;
		targetSocket.currentCallId = callId;

		const fromLabel = socket.role === 'operator'
			? 'Operatör'
			: `Koltuk ${socket.seatNumber}`;

		targetSocket.emit('call:incoming', {
			from: socket.role === 'operator' ? 'operator' : `seat-${socket.seatNumber}`,
			fromLabel,
			callId,
		});

		console.log(`Call ${callId}: ${socket.id} → ${targetSocket.id} (target: ${target})`);
	});

	socket.on('call:accept', ({ callId }) => {
		const call = activeCalls.get(callId || socket.currentCallId);
		if (!call) return;

		call.startTime = Date.now();
		call.callerSocket.emit('call:accepted', { callId: call.callId });
		console.log(`Call ${call.callId} accepted`);
		broadcastSeatList();
	});

	socket.on('call:reject', ({ callId, reason }) => {
		const call = activeCalls.get(callId || socket.currentCallId);
		if (!call) return;

		call.callerSocket.emit('call:rejected', { reason });
		console.log(`Call ${call.callId} rejected: ${reason || 'no reason'}`);
		cleanupCall(call.callId);
	});

	socket.on('call:end', () => {
		console.log(`Call end requested by ${socket.id}`);
		endCallForSocket(socket);
	});

	// *****************************************
	// WEBRTC SIGNALING RELAY
	// *****************************************

	socket.on('call:offer', ({ sdp }) => {
		const call = activeCalls.get(socket.currentCallId);
		if (!call) return;
		const other = call.callerSocket === socket ? call.calleeSocket : call.callerSocket;
		other.emit('call:offer', { sdp });
	});

	socket.on('call:answer', ({ sdp }) => {
		const call = activeCalls.get(socket.currentCallId);
		if (!call) return;
		const other = call.callerSocket === socket ? call.calleeSocket : call.callerSocket;
		other.emit('call:answer', { sdp });
	});

	socket.on('call:ice', ({ candidate }) => {
		const call = activeCalls.get(socket.currentCallId);
		if (!call) return;
		const other = call.callerSocket === socket ? call.calleeSocket : call.callerSocket;
		other.emit('call:ice', { candidate });
	});

	socket.on('writeRegister', async function (data) {
		try {
			const test = typeof data === 'string' ? JSON.parse(data) : data;
			console.log('writeRegister', test.register, test.value);
			const bufData = await writeData(test.register, test.value);
			enqueuePLC(bufData, `writeRegister ${test.register}`);
		} catch (err) {
			console.log('writeRegister error:', err);
		}
	});

	socket.on('writeBit', async function (data) {
		try {
			console.log('writeBit', data);
			const bufData = await writeBit(data.register, data.value);
			enqueuePLC(bufData, `writeBit ${data.register}`);
		} catch (err) {
			console.log('writeBit error:', err);
		}
	});

	socket.on('writeMultipleRegisters', async function (data) {
		try {
			const test = typeof data === 'string' ? JSON.parse(data) : data;
			console.log('writeMultipleRegisters', test);
			const bufData = await writeMultipleData(test.address, test.values);
			enqueuePLC(bufData, `writeMultiple ${test.address}`);
		} catch (err) {
			console.log('writeMultipleRegisters error:', err);
		}
	});
});

// const convert = require('amrhextotext');
// ☻014600075003700000000138800000000FFD9008200320000000000003FFC00000000C1♥
// var client = net.connect(500, '192.168.2.3', function () {
// 	console.log('Connected');
// 	//client.setEncoding('ascii');
// 	setInterval(() => {
// 		client.write(bufB);
// 	}, 500);
// });

// client.on('data', function (data) {
// 	console.log(
// 		'Receive client send data : ' + data + ', data size : ' + client.bytesRead
// 	);

// 	const buff = Buffer.from(data.slice(6, data.length - 3), 'hex');

// 	const size = buff.length / 4;

// 	for (let index = 0; index < size; index++) {
// 		console.log(
// 			index,
// 			parseInt(buff.slice(index * 4, index * 4 + 4).toString(), 16)
// 		);
// 	}
// });

// client.on('timeout', function () {
// 	console.log('Client request time out. ');
// });

// *****************************************
// EXAMPLE USAGE FOR MULTIPLE DATA WRITE
// *****************************************
//
// Usage example for writeMultipleData function:
//
// 1. Direct function call:
//    const buffer = await writeMultipleData('WY16', [0xAAAA, 0x5555]);
//    // This writes 0xAAAA to WY16 and 0x5555 to WY32 (continuous registers)
//
// 2. Via socket event (from client):
//    socket.emit('writeMultipleRegisters', {
//        startRegister: 'WY16',
//        values: [43690, 21845]  // decimal values
//    });
//
// The function follows the protocol specification:
// - STN: 01 (Station Number)
// - CMD: 47 (Continuous Register Data Write command)
// - NUM: Number of values to write (hex format)
// - ADDR: Starting register address
// - DATA: Array of values in hex format
// - LRC: Calculated checksum
//
