/*
* common.ts
*
* Common JSON Schema objects that make up a schema combinator library.
*
* These are not strictly JSON Schemas (they have extra fields for
* auto-completions, etc) but core/lib/schema.ts includes a
* `normalizeSchema()` call that takes a schema produced here and
* returns a valid JSON Schema object.
*
* Copyright (C) 2020 by RStudio, PBC
*
*/

import { CaseConvention, resolveCaseConventionRegex } from "../text.ts";

import {
  AllOfSchema,
  AnyOfSchema,
  ArraySchema,
  ConcreteSchema,
  EnumSchema,
  JSONValue,
  NumberSchema,
  ObjectSchema,
  RefSchema,
  Schema,
  schemaDescription,
  StringSchema,
} from "./types.ts";

////////////////////////////////////////////////////////////////////////////////

export function tagSchema<T extends ConcreteSchema>(
  schema: T,
  // deno-lint-ignore no-explicit-any
  tags: Record<string, any>,
): T {
  return {
    ...schema,
    tags: {
      ...(schema.tags || {}),
      ...tags,
    },
  };
}

export function numericSchema(obj: {
  "type": "integer" | "number";
  "minimum"?: number;
  "maximum"?: number;
  "exclusiveMinimum"?: number;
  "exclusiveMaximum"?: number;
  "multipleOf"?: number;
  "description"?: string;
}): NumberSchema {
  return Object.assign({
    description: "be a number",
  }, obj);
}

// export const anySchema = {
//   "description": "be anything",
// };

export function enumSchema(...args: JSONValue[]): EnumSchema {
  if (args.length === 0) {
    throw new Error("Internal Error: Empty enum schema not supported.");
  }
  return {
    "type": "enum",
    "enum": args,
    "description": args.length > 1
      ? `be one of: ${args.map((x) => "`" + x + "`").join(", ")}`
      : `be '${args[0]}'`,
    "completions": args.map(String),
    "exhaustiveCompletions": true,
  };
}

export function regexSchema(arg: string, description?: string): StringSchema {
  const result: Schema = {
    "type": "string",
    "pattern": arg,
  };
  if (description) {
    result.description = description;
  } else {
    result.description = `be a string that satisfies regex "${arg}"`;
  }
  return result;
}

export function anyOfSchema(...args: Schema[]): AnyOfSchema {
  return {
    "type": "anyOf",
    "anyOf": args,
    "description": `be at least one of: ${
      args.map((x) => schemaDescription(x).slice(3)).join(", ")
    }`,
  };
}

export function allOfSchema(...args: Schema[]): AllOfSchema {
  return {
    "type": "allOf",
    "allOf": args,
    "description": `be all of: ${
      args.map((x) => schemaDescription(x).slice(3)).join(", ")
    }`,
  };
}

// TODO add dynamic check for requiredProps being a subset of the
// keys in properties
export function objectSchema(params: {
  properties?: { [k: string]: Schema };
  patternProperties?: { [k: string]: Schema };
  propertyNames?: Schema;
  required?: string[];
  exhaustive?: boolean;
  additionalProperties?: Schema;
  description?: string;
  baseSchema?: ObjectSchema;
  completions?: { [k: string]: unknown }; // FIXME the value should be string | that completions object we can create.
  namingConvention?: CaseConvention[] | "ignore";
} = {}): ObjectSchema {
  let {
    properties,
    patternProperties,
    required,
    additionalProperties,
    description,
    baseSchema,
    exhaustive,
    completions: completionsParam,
    namingConvention,
    propertyNames: propertyNamesSchema,
  } = params;

  required = required || [];
  properties = properties || {};
  patternProperties = patternProperties || {};
  // deno-lint-ignore no-explicit-any
  const tags: Record<string, any> = {};
  let tagsAreSet = false;
  let propertyNames: Schema | undefined = propertyNamesSchema;

  const objectKeys = Object.getOwnPropertyNames(completionsParam || properties);

  if (namingConvention !== "ignore") {
    const { pattern, list } = resolveCaseConventionRegex(
      objectKeys,
      namingConvention,
    );
    if (pattern !== undefined) {
      if (propertyNames === undefined) {
        propertyNames = {
          "type": "string",
          pattern,
        };
      } else {
        propertyNames = allOfSchema(
          propertyNames,
          {
            "type": "string",
            pattern,
          },
        );
      }
      tags["case-convention"] = list;
      tagsAreSet = true;
    }
  }
  if (completionsParam) {
    tags["completions"] = completionsParam;
    tagsAreSet = true;
  }

  const hasDescription = description !== undefined;
  description = description || "be an object";
  let result: Schema | undefined = undefined;

  if (baseSchema) {
    if (baseSchema.type !== "object") {
      throw new Error("Internal Error: can only extend other object Schema");
    }
    result = Object.assign({}, baseSchema);
    // remove $id from base schema to avoid names from getting multiplied
    if (result.$id) {
      delete result.$id;
    }

    if (exhaustive && baseSchema.exhaustiveCompletions) {
      result.exhaustiveCompletions = true;
    }

    if (hasDescription) {
      result.description = description;
    }

    result.properties = Object.assign({}, result.properties, properties);
    result.patternProperties = Object.assign(
      {},
      result.patternProperties,
      patternProperties,
    );

    if (required) {
      result.required = (result.required || []).slice();
      result.required.push(...required);
    }

    // if (
    //   (result.completions && result.completions.length) ||
    //   completions.length
    // ) {
    //   result.completions = (result.completions || []).slice();
    //   result.completions.push(...completions);
    //   result.completions = uniqueValues(result.completions);
    // }

    if (additionalProperties !== undefined) {
      // TODO Review. This is likely to be confusing, but I think
      // it's the correct semantics for subclassing
      if (result.additionalProperties === false) {
        throw new Error(
          "Internal Error: don't know how to subclass object schema with additionalProperties === false",
        );
      }
      if (result.additionalProperties) {
        result.additionalProperties = allOfSchema(
          result.additionalProperties,
          additionalProperties,
        );
      } else {
        result.additionalProperties = additionalProperties;
      }
    }

    // propertyNames === undefined means that the behavior should be
    // identical to `propertyNames: true`.
    //
    // The semantics of extending schema A through B should be that the resulting
    // propertyNames behaves as anyOf(A.propertyNames, B.propertyNames)
    //
    // If either of those is undefined, then we get anyOf(true, .) or anyOf(., true),
    // which is equivalent to true, which is equivalent to undefined.
    //
    // as a result, we only set propertyNames on the extended schema if both
    // A.propertyNames and B.propertyNames are defined.

    if (propertyNames !== undefined && result.propertyNames !== undefined) {
      result.propertyNames = anyOfSchema(propertyNames, result.propertyNames);
    }
  } else {
    result = {
      "type": "object",
      description,
    };

    if (exhaustive) {
      result.exhaustiveCompletions = true;
    }

    if (properties) {
      result.properties = properties;
    }

    if (patternProperties) {
      result.patternProperties = patternProperties;
    }

    if (required && required.length > 0) {
      result.required = required;
    }

    // if (completions.length) {
    //   result.completions = completions;
    // }

    // this is useful to characterize Record<string, foo> types: use
    // objectSchema({}, [], foo)
    //
    // additionalProperties can be either a schema or "false", so
    // we need to check for undefined instead of a simple truthy check
    if (additionalProperties !== undefined) {
      result.additionalProperties = additionalProperties;
    }

    if (propertyNames !== undefined) {
      result.propertyNames = propertyNames;
    }
  }

  if (tagsAreSet) {
    result.tags = tags;
  }
  return result;
}

export function arraySchema(items?: Schema): ArraySchema {
  if (items) {
    return {
      "type": "array",
      "description": `be an array of values, where each element must ${
        schemaDescription(items)
      }`,
      items,
    };
  } else {
    return {
      "type": "array",
      "description": `be an array of values`,
    };
  }
}

export function documentSchema<T extends ConcreteSchema>(
  schema: T,
  doc: string,
): T {
  const result = Object.assign({}, schema);
  result.documentation = doc;
  return result;
}

// this overrides the automatic description
export function describeSchema<T extends ConcreteSchema>(
  schema: T,
  description: string,
): T {
  const result = Object.assign({}, schema);
  result.description = `be ${description}`;
  return result;
}

export function completeSchema<T extends ConcreteSchema>(
  schema: T,
  ...completions: string[]
): T {
  const result = Object.assign({}, schema);
  const prevCompletions = (schema.completions || []).slice();
  prevCompletions.push(...completions);
  result.completions = prevCompletions;
  return result;
}

export function completeSchemaOverwrite<T extends ConcreteSchema>(
  schema: T,
  ...completions: string[]
): T {
  const result = Object.assign({}, schema);
  result.completions = completions;
  return result;
}

export function idSchema<T extends ConcreteSchema>(schema: T, id: string): T {
  const result = Object.assign({}, schema);
  result["$id"] = id;
  return result;
}

export function errorMessageSchema<T extends ConcreteSchema>(
  schema: T,
  errorMessage: string,
): T {
  return {
    ...schema,
    errorMessage,
  };
}

// JSON schemas don't even allow $ref to have descriptions,
// but we use it here to allow our automatic description creation
export function refSchema($ref: string, description: string): RefSchema {
  return {
    "type": "ref",
    $ref,
    description,
  };
}

export function valueSchema(
  val: number | boolean | string,
  description?: string,
): EnumSchema {
  return {
    "type": "enum",
    "enum": [val], // enum takes non-strings too (!)
    "description": description || `be ${JSON.stringify(val)}`,
  };
}
