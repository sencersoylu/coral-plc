const Sequelize = require('sequelize');

const sequelize = new Sequelize({
	dialect: 'sqlite',
	storage: '../database.sqlite',
});

const db = {};

db.Sequelize = Sequelize;
db.sequelize = sequelize;

db.sensors = require('./sensor.model.js')(sequelize, Sequelize);
db.config = require('./config.model.js')(sequelize, Sequelize);

module.exports = db;
