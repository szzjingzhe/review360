<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { realApi } from '../api/real';
const rows=ref<Record<string,any>[]>([]),loading=ref(true),error=ref(''),cycle=ref('');
const cycles=computed(()=>[...new Map(rows.value.map(r=>[r.cycle_id,{id:r.cycle_id,title:r.title,month:r.month}])).values()]);
const visible=computed(()=>rows.value.filter(r=>!cycle.value||r.cycle_id===cycle.value));
const score=(v:unknown)=>v==null?'不可计算':Number(v).toFixed(2);
async function load(){loading.value=true;error.value='';try{rows.value=await realApi.listPublishedResults();}catch(e:any){error.value=e.message||'读取失败';}finally{loading.value=false;}}
onMounted(load);
</script>
<template><div><h1>已发布结果</h1><p>仅展示授权范围内已正式发布的成绩；自评单独展示，不参与最终成绩。</p>
<p v-if="loading">正在读取…</p><p v-else-if="error" role="alert">{{error}} <button @click="load">重试</button></p>
<div v-else class="card"><label>评价周期 <select v-model="cycle"><option value="">全部已发布周期</option><option v-for="c in cycles" :key="c.id" :value="c.id">{{c.month}} {{c.title}}</option></select></label>
<p v-if="!visible.length">暂无已发布结果</p><table v-else class="table"><thead><tr><th>周期</th><th>成员</th><th>部门</th><th>最终成绩</th><th>自评成绩</th><th>结果版本</th></tr></thead><tbody><tr v-for="r in visible" :key="r.id"><td>{{r.title}}</td><td>{{r.target_name}}</td><td>{{r.department_name}}</td><td>{{score(r.final_score)}}</td><td>{{score(r.self_score)}}</td><td>{{r.publication_version}}</td></tr></tbody></table></div></div></template>
