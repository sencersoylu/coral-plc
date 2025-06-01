const express = require('express');

const router = express.Router();

router.use([require('./sensors.js')]);

module.exports = router;
