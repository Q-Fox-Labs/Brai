// ABOUTME: Проверяет owner-схему component.json до подготовки npm-зависимостей в CI.
// ABOUTME: Поддерживает только используемые owner-схемой keywords и отвергает неизвестные.
const annotations = new Set(['$schema','$id','title','description','definitions']);
const keywords = new Set(['$ref','type','const','enum','required','properties','additionalProperties','items','uniqueItems','minItems','maxItems','minimum','maximum','minLength','maxLength','pattern','allOf','if','then']);
/** Проверяет ограниченную owner-схему Draft-07; новая возможность требует явной реализации. */
export function descriptorValidator(schema) {
  function validate(value, rule) {
    for (const key of Object.keys(rule)) if (!keywords.has(key) && !annotations.has(key)) throw Error(`UNSUPPORTED_COMPONENT_SCHEMA: ${key}`);
    if (rule.$ref) {
      if (!rule.$ref.startsWith('#/')) throw Error('EXTERNAL_COMPONENT_SCHEMA_REF');
      return validate(value, rule.$ref.slice(2).split('/').reduce((item,key)=>item?.[key],schema));
    }
    const type = value===null?'null':Array.isArray(value)?'array':typeof value;
    if (rule.type && !(Array.isArray(rule.type)?rule.type:[rule.type]).some(expected=>expected===type||(expected==='integer'&&Number.isInteger(value)))) return false;
    if(type==='number'&&((rule.minimum!==undefined&&value<rule.minimum)||(rule.maximum!==undefined&&value>rule.maximum)))return false;
    if ('const' in rule && JSON.stringify(value)!==JSON.stringify(rule.const)) return false;
    if (rule.enum && !rule.enum.includes(value)) return false;
    if (type==='object') {
      if (rule.required?.some(key=>!(key in value))) return false;
      for (const [key,item] of Object.entries(value)) {
        if (rule.properties?.[key]) {if(!validate(item,rule.properties[key]))return false;}
        else if(rule.additionalProperties===false)return false;
      }
    }
    if (type==='array') {
      if(rule.minItems!==undefined&&value.length<rule.minItems)return false;
      if(rule.maxItems!==undefined&&value.length>rule.maxItems)return false;
      if(rule.items && value.some(item=>!validate(item,rule.items)))return false;
      if(rule.uniqueItems && new Set(value.map(item=>JSON.stringify(item))).size!==value.length)return false;
    }
    if(type==='string' && ((rule.minLength && [...value].length<rule.minLength)||(rule.maxLength!==undefined&&[...value].length>rule.maxLength)||(rule.pattern && !new RegExp(rule.pattern,'u').test(value))))return false;
    if(rule.allOf?.some(item=>!validate(value,item)))return false;
    if(rule.if && validate(value,rule.if) && rule.then && !validate(value,rule.then))return false;
    return true;
  }
  return value=>validate(value,schema);
}
