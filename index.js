// noffle: hey, since you're rewriting this anyways, what do you think about
// writing the code in such a way that the hyperdb/trie code lives separate
// from the hypercore multiwrite code? This would make splitting
// hypercore-multiwriter into its own module in the future much easier.
var hypercore = require('hypercore')
var ram = require('random-access-memory')
var sodium = require('sodium-universal')
var hash = require('./lib/hash')
var iterator = require('./lib/iterator')

module.exports = DB

function DB () {
  if (!(this instanceof DB)) return new DB()
  this._feeds = []
  this._length = -1
}

DB.prototype.snapshot = function () {
  var snapshot = new DB()
  // noffle: Won't this reference to _feeds be mutated if the original db
  // mutates its _feeds? _feeds.length may also stop matching.
  snapshot._feeds = this._feeds
  snapshot._length = this._feeds.length
  return snapshot
}

DB.prototype.put = function (key, val, cb) {
  if (!cb) cb = noop
  if (this._length > -1) return process.nextTick(cb, new Error('Cannot put on a snapshot'))

  key = normalizeKey(key)
  var path = hash(key, true)
  var writable = this._feeds[0]

  if (!writable) writable = this._feeds[0] = []

  var node = {
    path: path,
    feed: 0,
    seq: writable.length,
    key: key,
    value: val,
    trie: []
  }

  if (!writable.length) {
    writable.push(node)
    return cb(null)
  }

  // noffle: maybe split the part below into an 'updateTrieForNewNode'
  // function?

  var head = writable[writable.length - 1]

  // each bucket works as a bitfield
  // noffle: "index" == "trie"?
  // noffle: "key" == "path element"?
  // i.e. an index corresponds to a key (2 bit value) + 0b100 (hash.TERMINATE)
  // since this is eventual consistent + hash collisions there can be more than
  // one value for each key so this is a two dimensional array

  var localBucket
  var localValues
  var remoteBucket
  var remoteValues

  for (var i = 0; i < path.length; i++) {
    var val = path[i] // the two bit value
    var headVal = head.path[i] // the two bit value of the current head

    localBucket = node.trie[i] // forks in the trie for this index
    remoteBucket = head.trie[i] || [] // remote forks

    // copy old trie for unrelated values
    for (var j = 0; j < remoteBucket.length; j++) {
      // if j === val, we are the newest node for this value
      // and we then don't want to copy the old trie.
      // if the value is a termination, we have a hash collision and then
      // we must copy it
      if (j === val && val !== hash.TERMINATE) continue

      if (!localBucket) localBucket = node.trie[i] = []
      if (!localBucket[j]) localBucket[j] = []
      localValues = localBucket[j]
      remoteValues = remoteBucket[j] || []

      for (var k = 0; k < remoteValues.length; k++) {
        var remoteVal = remoteValues[k]

        // might be a collions, check key and stuff
        if (val === hash.TERMINATE) {
          var resolved = this.feed[remoteVal.seq]
          console.log('todo: implement me here ...')
          return
        }

        // push the old value
        localValues.push(remoteVal)
      }
    }

    // check if trie is splitting
    if (headVal !== val || (headVal === hash.TERMINATE && head.key !== key)) {
      // we cannot follow the heads trie anymore --> change head to a closer one if possible

      // add head to our trie, so we reference back
      if (!localBucket) localBucket = node.trie[i] = []
      if (!localBucket[headVal]) localBucket[headVal] = []
      localValues = localBucket[headVal]
      localValues.push({feed: head.feed, seq: head.seq})

      // check if head has a closer pointer
      remoteValues = remoteBucket[val]
      if (!remoteValues || !remoteValues.length) break

      if (remoteValues.length > 1) {
        console.log('put fork!')
        process.exit()
      }

      head = this._feeds[remoteValues[0].feed][remoteValues[0].seq]
      continue
    }
  }

  writable.push(node)
  cb(null)
}

DB.prototype.get = function (key, opts, cb) {
  if (typeof opts === 'function') return this.get(key, null, opts)

  key = normalizeKey(key)
  var prefixed = !!(opts && opts.prefix)

  // If we the logs are empty -> 404
  var len = this._length > -1 ? this._length : this._feeds[0].length
  if (!len) return cb(null, null)

  // Get the entry point (these nodes act as the version of the db)
  var head = this._feeds[0][len - 1]
  var path = hash(key, !prefixed)

  // We want to find the key closest to our path.
  // At max, we need to go through path.length iterations
  for (var i = 0; i < path.length; i++) {
    var val = path[i]
    if (head.path[i] === val) continue

    // We need a closer node. See if the trie has one that
    // matches the path value
    var remoteBucket = head.trie[i] || []
    var remoteValues = remoteBucket[val] || []

    // No closer ones -> 404
    if (!remoteValues.length) return cb(null, null)

    if (remoteValues.length > 1) {
      console.log('fork')
      process.exit(1)
    }

    // Recursive from a closer node
    head = this._feeds[remoteValues[0].feed][remoteValues[0].seq]
  }

  if (prefixed && isPrefix(head.key, key)) return cb(null, [head])
  if (head.key === key) return cb(null, [head])
  cb(null, null)
}

DB.prototype.list = function (prefix, opts, cb) {
  if (typeof opts === 'function') return this.list(prefix, null, opts)

  var ite = this.iterator(prefix, opts)
  var list = []

  // noffle: woah, iterators are super cool! nice abstraction
  ite.next(loop)

  function loop (err, nodes) {
    if (err) return cb(err)
    if (!nodes) return cb(null, list)
    list.push(nodes)
    ite.next(loop)
  }
}

DB.prototype.iterator = function (prefix, opts) {
  return iterator(this, normalizeKey(prefix), opts)
}

DB.prototype.createReadStream = function (prefix, opts) {
  var ite = this.iterator(prefix, opts)
  var from = require('from2')

  // noffle: so simple! <3
  return from.obj(read)

  function read (size, cb) {
    ite.next(cb)
  }
}

function isPrefix (key, prefix) {
  if (!prefix.length || prefix[prefix.length - 1] !== '/') prefix += '/'
  return key.slice(0, prefix.length) === prefix
}

function normalizeKey (key) {
  if (!key.length) return '/'
  return key[0] === '/' ? key : '/' + key
}

function noop () {}

function Thread () {

}

