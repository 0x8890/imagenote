'use strict'

const cookie = require('cookie')
const moment = require('moment')
const numeral = require('numeral')
const qs = require('querystring')
const url = require('url')
const path = require('path')
const fs = require('fs')
const fortune = require('fortune')
const ejs = require('ejs')
const minifier = require('html-minifier')
const settings = require('../settings')

const Serializer = fortune.Serializer
const findMethod = fortune.methods.find
const createMethod = fortune.methods.create
const updateMethod = fortune.methods.update
const deleteMethod = fortune.methods.delete
const NotFoundError = fortune.errors.NotFoundError
const UnauthorizedError = fortune.errors.UnauthorizedError
const UnsupportedError = fortune.errors.UnsupportedError

// Template initialization.
const templates = {}
const templateDir = path.join(__dirname, '../../assets/templates')
const files = fs.readdirSync(templateDir)

for (let filename of files) {
  const filePath = path.join(templateDir, filename)
  const payload = minifier.minify(fs.readFileSync(filePath).toString(), {
    collapseWhitespace: true, removeComments: true
  })
  templates[path.basename(filename, '.ejs')] =
    ejs.compile(payload, { client: true })
}

// HTTP details.
const typeMap = {
  images: 'ImageObject',
  comments: 'Comment'
}

const methodMap = {
  GET: findMethod,
  POST: createMethod
}

const trailingSlash = /\/$/

function HtmlSerializer () {
  Serializer.apply(this, arguments)
}

HtmlSerializer.prototype = Object.assign(
Object.create(Serializer.prototype), {

  processRequest (context, request, response) {
    const isAdmin = cookie.parse(request.headers['cookie'] || '')
      .admin === settings.secret
    const parsedUrl = url.parse(request.url, true)
    const query = parsedUrl.query
    const pathname = parsedUrl.pathname
    const parts = parsedUrl.pathname.slice(1)
      .replace(trailingSlash, '').split('/')
      .map(x => decodeURIComponent(x))
    let maxParts = 0

    const q = []

    context.request.parts = parts
    context.request.pathname = pathname
    context.request.query = query
    context.request.isAdmin = isAdmin
    context.request.remoteAddress = request.remoteAddress
    context.request.method = methodMap[request.method]

    // Handle index route.
    return (parts[0] !== 'upload' ? new Promise((resolve, reject) => {
      context.request.type = 'ImageObject'
      context.request.options.match = {}
      context.request.options.sort = { uploadDate: false }
      context.request.options.limit = settings.perPage
      context.request.options.fields = {
        image: true, thumbnailUrl: true, viewers: true,
        blankData: true, keywords: true, about: true,
        name: true, description: true, uploadDate: true,
        width: true, height: true, comment: true
      }
      context.request.include = [ [ 'comment' ] ]
      maxParts = 1

      if (query.tag)
        context.request.options.match.keywords = (Array.isArray(query.tag) ?
          query.tag : query.tag.split(',')).map(x => x.trim().toLowerCase())

      if (query.id)
        context.request.options.match.about = (Array.isArray(query.id) ?
          query.id : query.id.split(',')).map(x => x.trim().toLowerCase())

      if (query.size) {
        const size = parseFloat(query.size)

        if (!Number.isNaN(size))
          q.push(`"megapixel" > ${size}`)
      }

      if (query.sort === 'views') {
        const sortViews = doSort.call(this,
          'views', 'viewers', 'previousViews')
        if (sortViews) return sortViews
      }

      else if (query.sort === 'comments') {
        const sortComments = doSort.call(this,
          'comments', 'comment', 'previousComments')
        if (sortComments) return sortComments
      }

      if (query.before &&
        query.sort !== 'views' && query.sort !== 'comments') {
        const time = parseInt(query.before, 10)

        if (!Number.isNaN(time)) {
          // Memoize the current query at this state.
          const k = q.slice(0)

          q.push(`"uploadDate" <= to_timestamp(${time / 1000})`)

          // Query for previous page.
          return this.adapter.find('ImageObject', null, {
            query: andWhereClause(k.concat(
              `"uploadDate" > to_timestamp(${time / 1000})`
            )),
            sort: { uploadDate: true },
            fields: { uploadDate: true },
            match: context.request.options.match,
            limit: settings.perPage
          })
          .then(records => {
            if (records.length)
              context.request.previousDate =
                records[records.length - 1].uploadDate.getTime()

            return resolve()
          })
          .catch(reject)
        }
      }

      return resolve()

      function doSort (queryName, fieldName, previousName) {
        context.request.options.sort = { [fieldName]: false }

        if (query[queryName]) {
          const queryValue = parseInt(query[queryName], 10)

          if (!Number.isNaN(queryValue)) {
            // Memoize the current query at this state.
            const k = q.slice(0)

            q.push(
              `coalesce(array_length("${fieldName}", 1), 0) <= ${queryValue}`)

            // Query for previous page.
            return this.adapter.find('ImageObject', null, {
              query: andWhereClause(k.concat(
                `coalesce(array_length("${fieldName}", 1), 0) > ${queryValue}`
              )),
              sort: { [fieldName]: true },
              fields: { [fieldName]: true },
              match: context.request.options.match,
              limit: settings.perPage
            })
            .then(records => {
              if (records.length)
                context.request[previousName] =
                  records[records.length - 1][fieldName].length

              return resolve()
            })
            .catch(reject)
          }
        }
      }
    }) : Promise.resolve())

    .then(() => {
      if (parts[0] === 'upload') maxParts = 1
      if (parts[0] === settings.secret) {
        context.response.meta['Set-Cookie'] =
          cookie.serialize('admin', settings.secret)
        context.response.meta['Location'] = request.headers['referer'] || '/'
        response.statusCode = 303
        maxParts = 1
      }

      // Modifying SQL query.
      context.request.options.query = andWhereClause(q)

      if (parts[0] in typeMap && context.request.method !== findMethod) {
        maxParts = 2
        context.request.type = typeMap[parts[0]]
        context.request.ids = parts[1] ? parts[1].split(',') : null
      }

      if (context.request.method === createMethod) {
        maxParts = 3
        if (parts[0] === 'upload') {
          context.request.type = 'ImageObject'
          maxParts = 1
        }

        if (parts[2])
          // Abusing HTTP semantics.
          if (parts[2] === 'edit') context.request.method = updateMethod
          else if (parts[2] === 'delete') {
            if (!isAdmin) throw new UnauthorizedError(`Not allowed to delete.`)
            context.request.method = deleteMethod
          }
          else parts.push()
      }

      if (parts.length > maxParts) throw new NotFoundError('Page not found.')

      return context
    })
  },

  processResponse (context, request, response) {
    const method = context.request.method
    const parts = context.request.parts

    if (parts[0] === 'upload' && method === createMethod &&
      !context.request.error) {
      response.statusCode = 303
      response.setHeader('Location', '/')
    }

    else if (method !== findMethod && !context.request.error) {
      response.statusCode = 303
      response.setHeader('Location', request.headers['referer'] || '/')
    }

    return context
  },

  showError (context, error) {
    context.request.error = error
    return this.showResponse(context)
  },

  showResponse (context, records, include) {
    const type = context.request.type
    const parts = context.request.parts
    const pathname = context.request.pathname

    const request = context.request
    const response = context.response

    const data = {
      settings, qs, moment, numeral, request, include,
      root: (path.relative(pathname, '/') || '.') + '/',
      title: '', flags: {}
    }

    if (records && type === 'ImageObject') data.images = records
    if (parts[0] === 'upload') {
      data.title = 'Upload'
      data.flags.isUpload = true
    }

    response.payload = templates.index(data)

    return context
  },

  parseCreate () {
    throw new UnsupportedError()
  },

  parseUpdate () {
    throw new UnsupportedError()
  }

})

HtmlSerializer.id = 'text/html'

module.exports = HtmlSerializer


function andWhereClause (q) {
  return sql => {
    if (q.length) {
      let hasWhereClause = false
      let i = sql.search(/ where/)

      if (~i) {
        hasWhereClause = true
        i += 6
      }
      else {
        const r = /from "(.*?)"/
        const f = sql.search(r)
        const l = r.exec(sql)[0].length
        sql = sql.slice(0, f + l) + ' where' + sql.slice(f + l)
        i = f + l + 6
      }

      sql = sql.slice(0, i) + ' ' + q.join(' and ') +
        (hasWhereClause ? ' and' : '') + sql.slice(i)
    }

    return sql
  }
}