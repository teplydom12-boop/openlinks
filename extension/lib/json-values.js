// Chrome storage and native JSON transports may reorder object keys. Compare
// JSON values, retaining strict types, exact key sets and ordered arrays.
export function sameJsonValue(left,right) {
  if(left===null || right===null || typeof left!=='object' || typeof right!=='object')return left===right;
  if(Array.isArray(left) || Array.isArray(right))return Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&left.every((value,index)=>sameJsonValue(value,right[index]));
  const keys=Object.keys(left);
  return keys.length===Object.keys(right).length&&keys.every(key=>Object.hasOwn(right,key)&&sameJsonValue(left[key],right[key]));
}
