const c = require('compact-encoding')
const sameObject = require('same-object')

const {
  SupportedTypes,
  getDefaultValue
} = require('./lib/types.js')
const generateCompactEncoders = require('./lib/codegen')

class BuilderNamespace {
  constructor (builder, name) {
    this.builder = builder
    this.name = name
  }

  register (description) {
    this.builder.types.push({ ...description, namespace: this.name })
  }
}
class Builder {
  constructor () {
    this.types = []
  }

  namespace (name) {
    return new BuilderNamespace(this, name)
  }

  toJSON () {
    return { version: 0, schema: this.types }
  }
}

class ResolvedType {
  constructor (hyperschema, description, fqn, versions, opts = {}) {
    const { primitive, struct, fields, positionMap } = opts
    this.hyperschema = hyperschema
    this.description = description
    this.name = description.name
    this.namespace = description.namespace
    this.fqn = fqn

    this.fields = fields
    this.positionMap = positionMap
    this.versions = versions

    this.compact = !!description.compact
    this.struct = !!struct
    this.primitive = !!primitive
    this.bool = this.name === 'bool'
    this.default = getDefaultValue(this.name)

    this.encodables = null
    this.optionals = null
    this.flagsPosition = -1
    if (Number.isInteger(description.flagsPosition)) {
      this.flagsPosition = description.flagsPosition
    }
  }

  preprocess () {
    if (this.encodables) return
    this.encodables = new Array(this.fields.length)
    this.optionals = []

    for (let i = 0; i < this.fields.length; i++) {
      const field = this.fields[i]
      const framed = !field.type.primitive && !field.type.compact
      const optional = !field.required
      const array = !!field.array

      let encoding = field.type.encoding
      if (array) encoding = c.array(encoding)
      if (framed) encoding = c.frame(encoding)

      let flag = 0
      if (optional) {
        if (this.flagsPosition === -1) {
          this.flagsPosition = i
        }
        flag = 2 ** this.optionals.length
        this.optionals.push({ name: field.name, version: field.version, flag })
      }
      this.encodables[i] = {
        default: array ? null : field.type.default,
        version: field.version,
        fqn: field.type.fqn,
        type: field.type,
        name: field.name,
        encoding,
        optional,
        framed,
        array,
        flag
      }
    }
  }

  static fromDescription (hyperschema, fqn, description) {
    if (description.alias) return hyperschema.resolve(description.alias)

    const previous = hyperschema.previous ? hyperschema.previous.fullyQualifiedTypes.get(fqn) : null

    const fields = []
    const positionMap = new Map()
    const structVersions = description.versions || hyperschema.getStructVersions(fqn)

    for (let i = 0; i < description.fields.length; i++) {
      const fieldDescription = description.fields[i]

      let fieldVersion = fieldDescription.version || hyperschema.version
      if (previous && previous.fields[i]) {
        // TODO: Do append-only checks here
        fieldVersion = previous.fields[i].version
      }

      const field = {
        ...fieldDescription,
        type: hyperschema.resolve(fieldDescription.type),
        version: fieldVersion
      }
      const position = fields.push(field) - 1
      positionMap.set(field.name, position)
    }

    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]
      if (field.version <= structVersions.latest) continue
      if (description.compact) {
        throw new Error('Cannot change fields in a compact type: ' + fqn)
      }
      structVersions.latest = field.version
    }

    return new this(hyperschema, description, fqn, structVersions, {
      struct: true,
      positionMap,
      fields
    })
  }

  static PrimitiveResolvedTypes = new Map([...SupportedTypes].map(name => {
    const description = { name, namespace: null }
    return [name, new this(null, description, name, { first: 1, latest: 1 }, { primitive: true })]
  }))
}

class HyperschemaNamespace {
  constructor (hyperschema, name) {
    this.hyperschema = hyperschema
    this.name = name
    this.types = new Map()
  }

  register (fqn, description) {
    if (this.types.has(description.name)) throw new Error('Duplicate type description')
    const type = ResolvedType.fromDescription(this.hyperschema, fqn, description)
    this.types.set(description.name, type)
    return type
  }
}

module.exports = class Hyperschema {
  static Builder = Builder

  constructor (description, { previous = null } = {}) {
    this.description = description

    this.fullyQualifiedTypes = new Map()
    this.namespaces = new Map()
    this.orderedTypes = []

    this.previous = previous
    this.version = previous ? previous.version : 1
    if (previous) {
      const strippedSchema = stripVersions(previous.description.schema)
      if (!sameObject(this.description.schema, strippedSchema)) {
        this.version += 1
      }
    }

    for (let i = 0; i < description.schema.length; i++) {
      const typeDescription = description.schema[i]
      if (!this.namespaces.has(typeDescription.namespace)) {
        const ns = new HyperschemaNamespace(this, typeDescription.namespace)
        this.namespaces.set(typeDescription.namespace, ns)
      }
      const ns = this.namespaces.get(typeDescription.namespace)
      const fqn = this._getFullyQualifiedName(typeDescription)
      const type = ns.register(fqn, typeDescription)

      const fullDescription = {
        description: typeDescription,
        versions: type.versions,
        name: fqn,
        type
      }
      this.fullyQualifiedTypes.set(fqn, type)
      this.orderedTypes.push(fullDescription)
    }
  }

  _getFullyQualifiedName (description) {
    return '@' + description.namespace + '/' + description.name
  }

  getStructVersions (type) {
    const prevType = this.previous && this.previous.fullyQualifiedTypes.get(type)
    if (prevType) return prevType.versions
    return { first: this.version, latest: this.version }
  }

  resolve (type) {
    if (ResolvedType.PrimitiveResolvedTypes.has(type)) return ResolvedType.PrimitiveResolvedTypes.get(type)
    return this.fullyQualifiedTypes.get(type)
  }

  encode (type, value) {
    const resolved = this.fullyQualifiedTypes.get(type)
    return resolved.encode(value)
  }

  decode (type, value) {
    const resolved = this.fullyQualifiedTypes.get(type)
    return resolved.decode(value)
  }

  toCode () {
    return generateCompactEncoders(this)
  }

  toJSON () {
    const output = {
      version: this.version,
      schema: []
    }
    for (const { description, type } of this.orderedTypes) {
      if (!description.fields) {
        output.schema.push({ ...description, versions: type.versions })
        continue
      }
      output.schema.push({
        ...description,
        versions: type.versions,
        fields: description.fields.map((f, i) => {
          return {
            ...f,
            version: type.fields[i].version
          }
        })
      })
    }
    return output
  }
}

function stripVersions (schema) {
  return schema.map(({ versions, fields, ...strippedType }) => {
    const strippedFields = fields?.map(({ version, ...strippedField }) => strippedField)
    if (!strippedFields) return strippedType
    return {
      ...strippedType,
      fields: strippedFields
    }
  })
}
