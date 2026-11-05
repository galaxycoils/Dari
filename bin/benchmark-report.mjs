export function summarize(rows) {
 const quantile=(values,q)=>{const sorted=values.toSorted((a,b)=>a-b);return sorted.length?sorted[Math.ceil(q*sorted.length)-1]:null;};
 const groups=[];
 for(const task of new Set(rows.map(r=>r.task)))for(const phase of new Set(rows.map(r=>r.phase)))for(const mode of ['legacy','optimized']){
  const group=rows.filter(r=>r.task===task&&r.phase===phase&&r.mode===mode);if(!group.length)continue;
  groups.push({task,phase,mode,trials:group.length,successes:group.filter(r=>r.success).length,p50_ms:quantile(group.filter(r=>r.success).map(r=>r.milliseconds),.5),p95_ms:quantile(group.filter(r=>r.success).map(r=>r.milliseconds),.95)});
 }
 return {groups,releaseGate:'Manual review required: >=30% lower suite median, no worse p95 or success rate, zero wrong-target/duplicate/false-success actions. These observations are not universal reliability proof.'};
}
