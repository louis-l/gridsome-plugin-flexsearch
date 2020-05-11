const path = require('path')
const fs = require('fs')
const cjson = require('compressed-json')
const FlexSearch = require('flexsearch')
const { v4: uuid } = require('uuid')
const _chunk = require('lodash.chunk')

function CreateSearchIndex (api, options) {
  const { searchFields = [], collections = [], flexsearch = {}, chunk = false } = options
  const { profile = 'default', ...flexoptions } = flexsearch

  const search = new FlexSearch({
    profile,
    ...flexoptions,
    doc: {
      id: 'id',
      field: searchFields
    }
  })

  const clientOptions = { pathPrefix: api._app.config._pathPrefix, siteUrl: api._app.config.siteUrl, ...options }
  api.setClientOptions(clientOptions)

  function getNode ({ typeName, id }) {
    const node = api._app.store.getNode(typeName, id)
    delete node.$loki
    delete node.$uid
    return node
  }

  function parseArray (array, stringify = true) {
    const [firstItem] = array
    if (firstItem && firstItem.typeName) return array.map(node => getNode(node))
    if (!stringify) return array
    // If this is for an index field, we need to stringify it so it can be indexed
    return JSON.stringify(array)
  }

  function parseObject (object, stringify = true) {
    if (Array.isArray(object)) return parseArray(object, stringify)
    if (object.typeName) return getNode(object)
    return Object.entries(object).reduce((obj, [key, value]) => ({ ...obj, [ key ]: parseObject(value) }), {})
  }

  api.onBootstrap(async () => {
    const docs = collections.flatMap(collection => {
      const collectionStore = api._app.store.getCollection(collection.typeName)
      if (!collectionStore) return

      return collectionStore.data().map(node => {
        delete node.$loki
        delete node.$uid
        // Fields that will be indexed, so must be included & flattened etc
        const indexFields = searchFields.reduce((obj, key) => {
          const value = node[ key ]
          if (!value) return { [ key ]: value, ...obj }
          if (typeof value === 'object') return { [ key ]: parseObject(value), ...obj }
          return { [ key ]: value, ...obj }
        }, {})

        // The doc fields that will be returned with the search result
        // We can either return just the fields a user has chosen, or return the whole node
        const docFields = collection.fields ? collection.fields.map(field => [field, node[ field ]]) : Object.entries(node)
        // Get any relations
        const doc = Object.fromEntries(docFields.map(([key, value]) => {
          if (!value) return [key, value]
          if (typeof value === 'object') return [key, parseObject(value, false)]
          return [key, value]
        }))

        return {
          index: collection.indexName,
          id: node.id,
          path: node.path,
          node: doc,
          ...indexFields
        }
      })
    })
    search.add(docs)

    console.log(`Added ${docs.length} nodes to Search Index`)
  })

  api.configureServer(app => {
    console.log('Serving search index...')
    if (chunk) {
      const { manifest, chunks } = createManifest()
      app.get('/flexsearch/manifest.json', (req, res) => {
        res.json(manifest)
      })
      app.get('/flexsearch/:chunk', (req, res) => {
        const chunkName = req.params.chunk.replace('.json', '')
        if (!chunk) res.status(404).send(`That chunk can't be found.`)
        res.json(chunks[ chunkName ])
      })
    } else {
      const searchIndex = search.export({ serialize: false })
      const compressedIndex = cjson.compress(searchIndex)
      app.get('/flexsearch.json', (req, res) => {
        res.json(compressedIndex)
      })
    }
  })

  api.afterBuild(async ({ config }) => {
    const outputDir = config.outputDir || config.outDir

    if (chunk) {
      console.log('Creating search index (chunked mode)...')
      const flexsearchDir = path.join(outputDir, 'flexsearch')
      const manifestFilename = path.join(flexsearchDir, 'manifest.json')

      const { manifest, chunks } = createManifest()

      await fs.mkdirSync(flexsearchDir)
      await fs.writeFileSync(manifestFilename, JSON.stringify(manifest))

      for (const [name, data] of Object.entries(chunks)) {
        const chunkFilename = path.join(flexsearchDir, `${name}.json`)
        await fs.writeFileSync(chunkFilename, JSON.stringify(data))
      }

      console.log('Saved search index.')
    } else {
      console.log('Creating search index...')
      const filename = path.join(outputDir, 'flexsearch.json')
      const searchIndex = search.export({ serialize: false })
      const compressedIndex = cjson.compress(searchIndex)
      await fs.writeFileSync(filename, JSON.stringify(compressedIndex))
      console.log('Saved search index.')
    }
  })

  function createManifest () {
    const searchIndex = search.export({ serialize: false, index: true, doc: false })
    const [searchDocs] = search.export({ serialize: false, index: false, doc: true })

    const chunkedIndex = searchIndex.reduce((manifest, index) => {
      const chunk = { id: uuid(), index }
      return {
        ids: [...manifest.ids, chunk.id],
        indexes: {
          ...manifest.indexes,
          [ chunk.id ]: cjson.compress(chunk.index)
        }
      }
    }, { ids: [], indexes: {} })

    const chunkSize = typeof chunk === 'number' ? chunk : 2000
    const chunkedDocs = _chunk(Object.entries(searchDocs), chunkSize).reduce((manifest, docs) => {
      const chunk = { id: uuid(), docs }

      return {
        ids: [...manifest.ids, chunk.id],
        docs: {
          ...manifest.docs,
          [ chunk.id ]: cjson.compress(chunk.docs)
        }
      }
    }, { ids: [], docs: {} })

    const manifest = {
      hash: uuid(),
      index: chunkedIndex.ids,
      docs: chunkedDocs.ids
    }

    return { manifest, chunks: { ...chunkedDocs.docs, ...chunkedIndex.indexes } }
  }
}

module.exports = CreateSearchIndex

module.exports.defaultOptions = () => ({
  chunk: false,
  autoFetch: true,
  autoSetup: true,
  flexsearch: { profile: 'default' },
  searchFields: [],
  collections: []
})
