const net = require('net');
require('dotenv').config();
const express = require('express');

const app = express();
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

const demo = 0;

const connections = []; // view soket bağlantılarının tutulduğu array
let isWorking = 0;
let isConnectedPLC = 0;

const sensorData = [];

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
	return (lrc & 0xff).toString(16);
}

async function openClientConnection() {
	return new Promise((resolve, reject) => {
		try {
			const client = new net.Socket();

			client.connect(500, '192.168.77.4');

			client.setTimeout(250, () => {
				isConnectedPLC = 2;
				client.end();
				sendMessage();
				reject('Connection Problem!');
			});

			client.on('ready', () => {
				isConnectedPLC = 1;
				resolve(client);
			});

			client.on('error', (err) => {
				isConnectedPLC = 2;
				sendMessage();
				reject('Connection Problem!');
			});

		

			client.on('data', (data) => {
				let test, buff;
				try {
					client.destroy();

					console.log(
						`Receive client send data : ${data}, data size : ${client.bytesRead}`
					);

					test = Buffer.from(data.slice(0, 4), 'hex');
					if (
						Buffer.compare(test, Buffer.from([0x02, 0x30, 0x31, 0x34])) == 0
					) {
						buff = Buffer.from(data.slice(6, data.length - 3), 'hex');

						const size = buff.length / 4;

						for (let index = 0; index < size; index++) {
							sensorData[index] = parseInt(
								buff.slice(index * 4, index * 4 + 4).toString(),
								16
							);
						}
					}
				} catch (error) {
					console.log(error);
				} finally {
					console.log('data recived');
					if (
						Buffer.compare(test, Buffer.from([0x02, 0x30, 0x31, 0x34])) == 0
					) {
						console.log(sensorData);
						sendMessage();
					}
				}
			});
		} catch (err) {
			console.log(err);
		}
	});
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
	console.log(`Writing ${numValues} values starting at ${startRegisterAddress}:`, values);

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

setInterval(async () => {
	if (demo == 0) {
		try {
			if (isWorking) {
				return;
			}
			//console.log('**************** START ****************');

			isWorking = 1;
			const client = await openClientConnection();
			//console.log(writeData())
			//let data = await writeData('R0020',87);
			//await client.write(data);
			
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

const bufB = Buffer.concat([
	bufA,
	Buffer.from([LRC[0].charCodeAt(), LRC[1].charCodeAt(), 0x03]),
]);
			
			await client.write(bufB);
		} catch (err) {
			console.log(err);
			isConnectedPLC = 0;
		} finally {
			isWorking = 0;
			// client.destroy();
			//console.log('**************** END ****************');
		}
	}
}, 500);

// ***********************************************************
// ***********************************************************
// SERVER CONFIGS
// ***********************************************************
// ***********************************************************
const server = http.Server(app);
server.listen(4000, () => console.log('Listening on port 4000'));

// ***********************************************************
// ***********************************************************
// IO CONFIGS
// ***********************************************************
// ***********************************************************
let io = socketIO(server, {
	cors: {
		origin: "*",
		methods: ["GET", "POST"]
	}
});

io.sockets.on('connection', (socket) => {
	connections.push(socket);
	console.log(' %s sockets is connected', connections.length);
	sendMessage();

	socket.on('coral-control', (msg) => {
    io.emit('coral-control', msg);
  });

	socket.on('disconnect', () => {
		connections.splice(connections.indexOf(socket), 1);
	});

	socket.on('writeRegister', async function (data) {
		console.log(data);

		try {
			//console.log('**************** START ****************');

			isWorking = 1;
			const client = await openClientConnection();

			console.log(data);
			let test = JSON.parse(data);
			console.log(test,test.register,test.value);

			let bufData = await writeData(test.register, test.value);
			await client.write(bufData);
		} catch (err) {
			console.log(err);
			isConnectedPLC = 0;
		} finally {
			isWorking = 0;
			// client.destroy();
			//console.log('**************** END ****************');
		}
	});

	socket.on('writeBit', async function (data) {
		console.log(data);

		try {
			console.log('**************** START ****************');

			isWorking = 1;
			const client = await openClientConnection();

			let bufData = await writeBit(data.register, data.value);
			await client.write(bufData);
		} catch (err) {
			console.log(err);
			isConnectedPLC = 0;
		} finally {
			isWorking = 0;
			// client.destroy();
			console.log('**************** END ****************');
		}
	});

	socket.on('writeMultipleRegisters', async function (data) {
		console.log('Writing multiple registers:', data);

		try {
			console.log('**************** START MULTIPLE WRITE ****************');

			isWorking = 1;
			const client = await openClientConnection();
			console.log(JSON.parse(data));
			let test = JSON.parse(data);
			console.log(test);

			let bufData = await writeMultipleData(test.address, test.values);
			await client.write(bufData);
		} catch (err) {
			console.log(err);
			isConnectedPLC = 0;
		} finally {
			isWorking = 0;
			// client.destroy();
			console.log('**************** END MULTIPLE WRITE ****************');
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
