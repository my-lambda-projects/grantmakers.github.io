const request = require('request');
const es = require('event-stream');
const Promise = require('bluebird');
const JSONStream = require('JSONStream');
const xml2jsParser = require('xml2js').parseString;
// const secrets = require('./secrets');

// IRS Indexes
const targetYear = '2017'; // Enter the year to fetch
const index = 'https://s3.amazonaws.com/irs-form-990/index_' + targetYear + '.json';

// Dates & Timestamps
const dateObj = new Date();
const month = (dateObj.getUTCMonth() + 1 < 10 ? '0' : '') + (dateObj.getUTCMonth() + 1);
const day = (dateObj.getUTCDate() < 10 ? '0' : '') + dateObj.getUTCDate();
const year = dateObj.getFullYear().toString().substr(2, 2);
const previousUpdate = new Date('2017-11-21T16:23:38.785Z');

// AWS
const AWS = require('aws-sdk');
AWS.config.update({'region': 'us-east-1'});
const s3 = new AWS.S3();

// Mongo
// local db
// const dbHostPort = 'localhost:27017';

// GCE shell
const dbHostPort = '127.0.0.1:27017';

// remote db
/*
const remoteUser = secrets.gce.user;
const remotePassword = secrets.gce.password;
const remoteHost = secrets.gce.host;
const remotePort = secrets.gce.port;
const dbHostPort =  remoteUser + ':' +
                  remotePassword + '@' +
                  remoteHost + ':' +
                  remotePort;
*/


const dbName  = 'grantmakers';
const dbCollection = 'irs' + targetYear + '_' + month + day + year;
const db = require('mongodb-promises').db(dbHostPort, dbName);
const mycollection = db.collection(dbCollection);

// xml2js
const parserOptions = {'explicitArray': false, 'emptyTag': undefined, 'attrkey': 'attributes'};

// Throttling helpers
const limit = 500;
let records = 0;
let skipped = 0;
let matches = 0;
let processed = 0;

// Main function
const paramsJSON = {'Bucket': 'irs-form-990', 'Key': 'index_2017.json'};
const s3Stream = s3.makeUnauthenticatedRequest('getObject', paramsJSON).createReadStream();
s3Stream
  .on('error', function(err) {
    console.error('-----Index Request Error-----');
    console.error(err);
  })
  .pipe(JSONStream.parse(['Filings' + targetYear, true]))
  .on('error', function(err) {
    console.error('-----JSONParse Error-----');
    console.error(err);
  })
  // .pipe(es.mapSync(function(data) {
  .pipe(es.map(function(data, callback) {
    records++;
    console.log('Records: ' + records + ' | Matches: ' + matches + ' | Processed: ' + processed + ' | Skipped: ' + skipped);
    throttleCheck();
    processFiling(data);
    callback(null, data);
    return;
  }))
  .on('error', function(err) {
    console.error('-----mapSync Error-----');
    console.error(err);
  })
  .on('end', function() {
    // Readable stream is finished
    console.log('-----JSON Request is Finished-----');
    // Close down db connection
    db.close();
  });

function throttleCheck() {
  if (matches - processed > limit) {
    s3Stream.pause();
  } else {
    s3Stream.resume();
  }
}

function processFiling(data) {
  // Filter results to only foundations w/ data available
  // if (data.URL && data.URL.length > 0 && data.FormType === '990PF' && new Date(data.LastUpdated) > previousUpdate) {
  if (data.URL && data.URL.length > 0 && data.FormType !== '990PF') {
    matches++;
    // Fetch XML using AWS SDK
    const targetKey = data.ObjectId + '_public.xml';
    const paramsXML = {'Bucket': 'irs-form-990', 'Key': targetKey};
    
    s3.makeUnauthenticatedRequest('getObject', paramsXML).promise()
      .then(function(resultXML) {
        // Parse the XML file
        return new Promise(function(resolve, reject) {
          xml2jsParser(resultXML.Body, parserOptions, function(err, result) {
            if (err) {
              return reject(err);
            } else {
              return resolve(result);
            }
          });
        });
      })
      .then(function(resultJS) {
        let obj = {};

        obj = {
          '_id': data.ObjectId,
          'last_updated_grantmakers': dateObj.toISOString(),
          'Index': data,
          'Return': resultJS.Return,
        };

        // Write the JS object to Mongo
        mycollection.save(obj)
          .then(function(resultArr) {
            processed++;
            throttleCheck();
            // s3Stream.resume();
          })
          .catch(function(err) {
            console.error('-----Mongo Insertion Error-----');
            console.error(err);
          });
      })
      .catch(function(err) {
        // errorCount++;
        console.error('-----XML Request Error-----');
        console.error(err);
      });
  } else {
    skipped++;
  }
}
