'use strict'

var Qlobber = require('qlobber').QlobberDedup
var Packet = require('aedes-packet')
var EE = require('events').EventEmitter
var inherits = require('util').inherits
var MultiStream = require('multistream')
var parallel = require('fastparallel')

var QlobberOpts = {
  wildcard_one: '+',
  wildcard_some: '#',
  separator: '/'
}
var newSubTopic = '$SYS/sub/add'
var rmSubTopic = '$SYS/sub/rm'
var subTopic = '$SYS/sub/+'

function CachedPersistence (opts) {
  if (!(this instanceof CachedPersistence)) {
    return new CachedPersistence(opts)
  }

  EE.call(this)

  this.ready = false
  this.destroyed = false
  this._parallel = parallel()
  this._matcher = new Qlobber(QlobberOpts)
  this._waiting = {}

  var that = this

  this.once('ready', function () {
    that.ready = true
  })

  this._onMessage = function onSubMessage (packet, cb) {
    var decoded = JSON.parse(packet.payload)
    var clientId = decoded.clientId
    for (var i = 0; i < decoded.subs.length; i++) {
      var sub = decoded.subs[i]
      sub.clientId = clientId
      if (packet.topic === newSubTopic) {
        // if (!checkSubsForClient(sub, that._matcher.match(sub.topic))) {
        that._matcher.add(sub.topic, sub.clientId)
        // }
      } else if (packet.topic === rmSubTopic) {
        that._matcher.remove(sub.topic, sub.clientId)
      }
    }
    var action = packet.topic === newSubTopic ? 'sub' : 'unsub'
    var waiting = that._waiting[clientId + '-' + action]
    delete that._waiting[clientId + '-' + action]
    if (waiting) {
      process.nextTick(waiting)
    }
    cb()
  }
}

inherits(CachedPersistence, EE)

CachedPersistence.prototype._waitFor = function (client, action, cb) {
  this._waiting[client.id + '-' + action] = cb
}

CachedPersistence.prototype._addedSubscriptions = function (client, subs, cb) {
  if (!this.ready) {
    this.once('ready', this._addedSubscriptions.bind(this, client, subs, cb))
    return
  }

  var errored = false

  this._waitFor(client, 'sub', function (err) {
    if (!errored && err) {
      return cb(err)
    }
    if (!errored) {
      cb(null, client)
    }
  })

  subs = subs.filter(qosGreaterThanOne)
  if (subs.length === 0) {
    return cb(null, client)
  }

  var ctx = {
    cb: cb || noop,
    client: client,
    broker: this._broker,
    topic: newSubTopic,
    brokerPublish: brokerPublish
  }
  ctx.brokerPublish(subs, function (err) {
    if (err) {
      errored = true
      cb(err)
    }
  })
}

function qosGreaterThanOne (sub) {
  return sub.qos > 0
}

function brokerPublish (subs, cb) {
  var encoded = JSON.stringify({clientId: this.client.id, subs: subs})
  var packet = new Packet({
    topic: this.topic,
    payload: encoded
  })
  this.broker.publish(packet, cb)
}

function noop () {}

CachedPersistence.prototype._removedSubscriptions = function (client, subs, cb) {
  if (!this.ready) {
    this.once('ready', this._removedSubscriptions.bind(this, client, subs, cb))
    return
  }
  var errored = false

  this._waitFor(client, 'unsub', function (err) {
    if (!errored && err) {
      return cb(err)
    }
    if (!errored) {
      cb(null, client)
    }
  })

  var ctx = {
    cb: cb || noop,
    client: client,
    broker: this._broker,
    topic: rmSubTopic,
    brokerPublish: brokerPublish
  }
  ctx.brokerPublish(subs, function (err) {
    if (err) {
      errored = true
      cb(err)
    }
  })
}

CachedPersistence.prototype.subscriptionsByTopic = function (topic, cb) {
  if (!this.ready) {
    this.once('ready', this.subscriptionsByTopic.bind(this, topic, cb))
    return this
  }

  cb(null, Array.from(this._matcher.match(topic)))
}

CachedPersistence.prototype.cleanSubscriptions = function (client, cb) {
  var that = this
  this.subscriptionsByClient(client, function (err, subs, client) {
    if (err || !subs) { return cb(err, client) }
    subs = subs.map(subToTopic)
    that.removeSubscriptions(client, subs, cb)
  })
}

CachedPersistence.prototype.outgoingEnqueueCombi = function (subs, packet, cb) {
  this._parallel({
    persistence: this,
    packet: packet
  }, outgoingEnqueue, subs, cb)
}

function outgoingEnqueue (sub, cb) {
  this.persistence.outgoingEnqueue(sub, this.packet, cb)
}

CachedPersistence.prototype.createRetainedStreamCombi = function (patterns) {
  var that = this
  var streams = patterns.map(function (p) {
    return that.createRetainedStream(p)
  })
  return MultiStream.obj(streams)
}

CachedPersistence.prototype.destroy = function (cb) {
  this.destroyed = true
  this.broker.unsubscribe(subTopic, this._onMessage, function () {
    if (cb) {
      cb()
    }
  })
}

// must emit 'ready'
CachedPersistence.prototype._setup = function () {
  this.emit('ready')
}

function subToTopic (sub) {
  return sub.topic
}

Object.defineProperty(CachedPersistence.prototype, 'broker', {
  enumerable: false,
  get: function () {
    return this._broker
  },
  set: function (broker) {
    this._broker = broker
    this.broker.subscribe(subTopic, this._onMessage, this._setup.bind(this))
  }
})

// function checkSubsForClient (sub, savedSubs) {
//   for (var i = 0; i < savedSubs.length; i++) {
//     if (sub.topic === savedSubs[i].topic && sub.clientId === savedSubs[i].clientId) {
//       return true
//     }
//   }
//   return false
// }

module.exports = CachedPersistence
module.exports.Packet = Packet
