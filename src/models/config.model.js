module.exports = (sequelize, Sequelize) => {
	const config = sequelize.define(
		'config',
		{
			projectName: Sequelize.STRING,
			pressureLimit: Sequelize.INTEGER,
			sessionCounterLimit: Sequelize.INTEGER,
			sessionTimeLimit: Sequelize.INTEGER,
		},
		{}
	);

	return config;
};
