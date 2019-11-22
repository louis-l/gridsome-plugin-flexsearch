const path = require('path')
const fs = require('fs')
const FlexSearch = require('flexsearch')

function CreateSearchIndex (api, { searchFields = [], collections = [], flexsearch = {} }) {
  const { profile = 'default', ...flexoptions } = flexsearch
  const search = new FlexSearch({
    profile,
    ...flexoptions,
    doc: {
      id: 'id',
      field: searchFields
    }
  })

  api.onCreateNode(node => {
    const collectionOptions = collections.find(({ typeName }) => typeName === node.internal.typeName)
    if (collectionOptions) {
      const index = { ...collectionOptions, fields: [...searchFields, ...collectionOptions.fields] }
      const docFields = index.fields.reduce((obj, key) => ({ [ key ]: node[ key ], ...obj }), {})

      const doc = {
        index: index.indexName,
        id: node.id,
        path: node.path,
        ...docFields
      }

      search.add(doc)
    }
  })

  api.configureServer(app => {
    console.log('Serving search index')
    const searchConfig = {
      searchFields,
      index: search.export({ serialize: false })
    }
    app.get('/search.json', (req, res) => {
      res.json(searchConfig)
    })
  })

  api.afterBuild(({ queue, config }) => {
    console.log('Saving search index')
    const filename = path.join(config.outputDir, 'search.json')
    const searchConfig = {
      searchFields,
      index: search.export({ serialize: false })
    }
    return fs.writeFileSync(filename, JSON.stringify(searchConfig))
  })
}

module.exports = CreateSearchIndex

module.exports.defaultOptions = () => ({
  flexsearch: { profile: 'default' },
  searchFields: [],
  collections: []
})
