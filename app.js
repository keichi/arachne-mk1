var rpc = require('k-rpc-socket');
var kue = require('kue')
var async = require('async')
var crypto = require('crypto');
var dns = require('dns');
var Sequelize = require('sequelize');
var geoip = require('geoip-lite');

var redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
var queue = kue.createQueue({ redis: redisUrl, jobEvents: false });

var mysqlUrl = process.env.MYSQL_URL || 'mysql://arachne:Arachne12345!@127.0.0.1/arachne';
var sequelize = new Sequelize(mysqlUrl, {
  logging: false,
  timezone: '+09:00'
});

var Node = sequelize.define('node', {
  ip: Sequelize.STRING,
  host: Sequelize.STRING,
  country: Sequelize.STRING,
  city: Sequelize.STRING,
  latitude: Sequelize.FLOAT,
  longitude: Sequelize.FLOAT
}, {
  indexes: [
    {
      fields: ['ip']
    }
  ]
});

var BOOTSTRAP_NODES = [
  {host: 'router.bittorrent.com', port: 6881},
  {host: 'router.utorrent.com', port: 6881},
  {host: 'dht.transmissionbt.com', port: 6881}
]

var randomID = function () {
  return new Buffer(crypto.randomBytes(20));
}

var selfID = randomID();
setInterval(function () {
  selfID = randomID();
}, 1000 * 60 * 15);

var decodeIP = function(buf) {
  return [ buf.readUInt8(0),
           buf.readUInt8(1),
           buf.readUInt8(2),
           buf.readUInt8(3) ].join('.');
};

var decodePort = function (buf) {
  return buf.readUInt16BE();
};

var decodeNodes = function (buf) {
  var nodes = [];

  for (var offset = 0; offset <= buf.length - 26; ) {
    var id = buf.slice(offset, offset += 20);
    var host = decodeIP(buf.slice(offset, offset += 4));
    var port = decodePort(buf.slice(offset, offset += 2));
    nodes.push({ id: id, host: host, port: port });
  }

  return nodes;
};

var encodeIP = function (ip) {
  return new Buffer(ip.split(".").map(function(x) { return parseInt(x); }));
};

var encodePort = function (port) {
  var buf = new Buffer(2);
  buf.writeUInt16BE(port);
  return buf;
};

var encodeNodes = function (nodes) {
  return Buffer.concat(
    nodes.map(function (node) {
      return Buffer.concat([
        node.id, encodeIP(node.host), encodePort(node.port)
      ]);
    })
  );
};

var join = function () {
  BOOTSTRAP_NODES.forEach(function(node) {
    queue.create('crawl', node).removeOnComplete(true).save();
  });
};

var shutdown = function (sig) {
  queue.shutdown(function (err) {
    process.exit(0);
  });
};

var storeNode = function (node, done) {
  var ip = node.host;

  stats.counter('dnsQueries').inc();

  dns.reverse(ip, function (err, hostnames) {
    stats.counter('dnsQueries').dec();

    var geo = geoip.lookup(ip);
    var country = geo ? (geo.country ? geo.country : null) : null;
    var city = geo ? (geo.city ? geo.city : null) : null;
    var latitude = geo ? (geo.ll ? geo.ll[0] : null) : null;
    var longitude = geo ? (geo.ll ? geo.ll[1] : null) : null;
    var host = hostnames ? hostnames[0] : null;

    stats.counter('storeNodeQueries').inc();
    Node.create({
      ip: ip,
      host: host,
      country: country,
      city: city,
      latitude: latitude,
      longitude: longitude
    }).finally(function () {
      stats.counter('storeNodeQueries').dec();
      done();
    });
  });
};

var processCrawl = function (job, done) {
  var node = job.data;
  stats.meter('crawledPerSecond').mark();
  stats.counter('krpcQueries').inc();

  if (node.port <= 0 || node.port > 65535) return done(new Error("Invalid port"));
  socket.query(node, {
    q: 'find_node',
    a: {
      id: selfID,
      target: randomID()
    }
  }, function (err, response) {
    stats.counter('krpcQueries').dec();
    if (err) return done(err);

    var nodes = response.r.nodes;
    if (!nodes) return done();

    async.each(decodeNodes(nodes), function(node, cb) {
      stats.meter('discoveredNodePerSecond').mark();

      stats.counter('findNodeQueries').inc();
      Node.findOne({where: {ip: node.host}}).then(function(result) {
        stats.counter('findNodeQueries').dec();

        async.parallel([function (cb) {
          if (result) return cb();
          storeNode(node, cb);
        }, function (cb) {
          queue.inactiveCount(function(err, total) {
            if (err) return cb(err);

            if (total > 100000) {
              // Queue is full, don't enque
              return cb();
            } else if (total < 100) {
              // Running out of jobs; let's query bootstrap nodes
              join();
            } else if (result) {
              // When 100 <= total <= 1000, don't enque visited nodes
              return cb();
            }

            node.title = 'Visit node at ' + node.host + ':' + node.port;
            queue.create('crawl', node).removeOnComplete(true).save(cb);
          });
        }], cb);
      }, function (err) {
        stats.counter('findNodeQueries').dec();
        return cb(err);
      });
    }, done);
  });
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

var stats = require('measured').createCollection();
stats.gauge('usedMemory', function () {
  return process.memoryUsage().rss;
});

var socket = rpc();

kue.app.listen(3000);
sequelize.sync();
join();

queue.process('crawl', 50, function (job, done) {
  var domain = require('domain').create();
  domain.on('error', function (err){
    done(err);
  });
  domain.run(function () {
    processCrawl(job, done);
  });
});

queue.on('error', function (err) {
  console.error('Oops:', err.message);
});

queue.on('job failed', function (id, result) {
  kue.Job.get(id, function (err, job) {
    if (err) return;
    job.remove();
  });
});

setInterval(function () {
  console.log(stats.toJSON());
}, 10000);

