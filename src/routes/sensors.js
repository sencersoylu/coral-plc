const express = require('express');
const router = express.Router();
const db = require('../models/index');
const { errorResponse, successResponse } = require('../helpers/index');

router.get('/list', async (req, res) => {
	try {
		const sensors = await db.sensors.findAll();
		successResponse(req, res, sensors);
	} catch (error) {
		errorResponse(req, res, error);
	}
});

module.exports = router;
