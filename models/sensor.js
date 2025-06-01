sequelize;
'use strict';
module.exports = (sequelize, DataTypes) => {

  const tanim = sequelize.define('sensors', {

    sensorID: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true
    },

      sensorName: DataTypes.STRING,
      sensorCaption: DataTypes.STRING,
      sensorMemory: DataTypes.INTEGER,
      sensorSymbol: DataTypes.STRING,
            sensorOffset: DataTypes.INTEGER,

      sensorLowerLimit: DataTypes.INTEGER,
      sensorUpperLimit: DataTypes.INTEGER,
      sensorAnalogUpper: DataTypes.INTEGER,



    

  }, {});

  tanim.associate = function (models) {
    // associations can be defined here

  };

  return tanim;

