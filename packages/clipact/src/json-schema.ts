import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from '@standard-schema/spec'

/** The subset of JSON Schema that {@link fromJsonSchema} validates. */
export interface JsonSchemaNode {
  type: 'object' | 'array' | 'string' | 'boolean'
  description?: string
  enum?: readonly string[]
  default?: unknown
  properties?: Record<string, JsonSchemaNode>
  required?: readonly string[]
  items?: JsonSchemaNode
  additionalProperties?: false
}

/**
 * Creates a Standard Schema from a small JSON Schema, for framework-owned
 * commands that cannot depend on an application's schema library.
 *
 * @see https://standardschema.dev/json-schema
 */
export function fromJsonSchema<Input, Output = Input>(
  schema: JsonSchemaNode
): StandardSchemaV1<Input, Output> & StandardJSONSchemaV1<Input, Output> {
  const jsonSchema = () => ({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    ...structuredClone(schema),
  })
  return {
    '~standard': {
      version: 1,
      vendor: 'clipact',
      validate(value) {
        const issues: StandardSchemaV1.Issue[] = []
        const result = check(schema, value, [], issues)
        return issues.length > 0 ? { issues } : { value: result as Output }
      },
      jsonSchema: { input: jsonSchema, output: jsonSchema },
    },
  }
}

/** Validates one value, applying defaults, and returns the result. */
function check(
  node: JsonSchemaNode,
  value: unknown,
  path: PropertyKey[],
  issues: StandardSchemaV1.Issue[]
): unknown {
  if (value === undefined && node.default !== undefined) {
    return structuredClone(node.default)
  }
  if (node.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      issues.push({ message: 'Expected an object', path })
      return value
    }
    const record = value as Record<string, unknown>
    const properties = node.properties ?? {}
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(record)) {
      if (!(key in properties) && node.additionalProperties === false) {
        issues.push({ message: 'Unknown field', path: [...path, key] })
      }
    }
    for (const [key, property] of Object.entries(properties)) {
      if (record[key] === undefined && property.default === undefined) {
        if (node.required?.includes(key)) {
          issues.push({ message: 'Required', path: [...path, key] })
        }
        continue
      }
      result[key] = check(property, record[key], [...path, key], issues)
    }
    return result
  }
  if (node.type === 'array') {
    if (!Array.isArray(value)) {
      issues.push({ message: 'Expected an array', path })
      return value
    }
    const items = node.items
    return items
      ? value.map((item, index) => check(items, item, [...path, index], issues))
      : value
  }
  if (typeof value !== node.type) {
    issues.push({ message: `Expected a ${node.type}`, path })
  } else if (node.enum && !node.enum.includes(value as string)) {
    issues.push({
      message: `Expected one of: ${node.enum.join(', ')}`,
      path,
    })
  }
  return value
}
