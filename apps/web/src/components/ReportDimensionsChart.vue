<script setup lang="ts">
import {computed,ref,onMounted,onUnmounted} from 'vue';
import {formatReportScore} from '../lib/growthReport';
const props=defineProps<{title:string;rows:Array<{key:string;label:string;weight:number|null;peer:number|null;self:number|null}>;peer?:boolean;self?:boolean}>();
const chart=ref<HTMLElement|null>(null),containerWidth=ref(640);
let observer:ResizeObserver|undefined;
onMounted(()=>{observer=new ResizeObserver(entries=>{containerWidth.value=entries[0].contentRect.width;});if(chart.value)observer.observe(chart.value);});
onUnmounted(()=>observer?.disconnect());
const width=computed(()=>Math.max(300,containerWidth.value));
const plotHeight=160,left=38,bottom=188;
const groupWidth=computed(()=>(width.value-left-14)/Math.max(1,props.rows.length));
const barWidth=computed(()=>Math.min(46,Math.max(18,groupWidth.value*.22)));
const center=(index:number)=>left+groupWidth.value*(index+.5);
const labelLines=(label:string)=>{const chars=[...label];return [chars.slice(0,7).join(''),chars.slice(7,14).join('')].filter(Boolean);};
const tooltip=(row:typeof props.rows[number])=>`${row.label}；权重${row.weight===null?'未提供':row.weight+'%'}；${props.peer?'匿名他评 '+formatReportScore(row.peer)+' 分；':''}${props.self?'我的自评 '+formatReportScore(row.self)+' 分':''}`;
</script>
<template><div ref="chart" class="dimension-chart"><svg :viewBox="`0 0 ${width} 264`" role="img" :aria-label="title+'，纵轴0至100分'"><g v-for="tick in [0,20,40,60,80,100]" :key="tick"><line :x1="left" :x2="width-14" :y1="bottom-tick/100*plotHeight" :y2="bottom-tick/100*plotHeight" stroke="#e5eaf2" stroke-dasharray="4 4"/><text :x="left-10" :y="bottom-tick/100*plotHeight+4" text-anchor="end" fill="#8492a8" font-size="11">{{tick}}</text></g>
 <g v-for="(row,index) in rows" :key="row.key" tabindex="0" :aria-label="tooltip(row)"><title>{{tooltip(row)}}</title>
  <g v-if="peer"><rect v-if="row.peer!==null" :x="center(index)-(self?barWidth+4:barWidth/2)" :y="bottom-row.peer/100*plotHeight" :width="barWidth" :height="row.peer/100*plotHeight" rx="5" fill="#246bfd"/><text :x="center(index)-(self?barWidth/2+4:0)" :y="row.peer===null?bottom-8:bottom-row.peer/100*plotHeight-7" text-anchor="middle" fill="#172b4d" font-size="12" font-weight="600">{{formatReportScore(row.peer)}}</text></g>
  <g v-if="self"><rect v-if="row.self!==null" :x="center(index)+(peer?4:-barWidth/2)" :y="bottom-row.self/100*plotHeight" :width="barWidth" :height="row.self/100*plotHeight" rx="5" fill="#a9c9ff"/><text :x="center(index)+(peer?barWidth/2+4:0)" :y="row.self===null?bottom-8:bottom-row.self/100*plotHeight-7" text-anchor="middle" fill="#172b4d" font-size="12" font-weight="600">{{formatReportScore(row.self)}}</text></g>
  <text :x="center(index)" y="211" text-anchor="middle" fill="#344054" font-size="12"><tspan v-for="(line,j) in labelLines(row.label)" :key="j" :x="center(index)" :dy="j?16:0">{{line}}</tspan></text><text :x="center(index)" y="252" text-anchor="middle" fill="#667085" font-size="11">{{row.weight===null?'权重未提供':'权重 '+row.weight+'%'}}</text>
 </g></svg><table class="sr-only"><caption>{{title}}</caption><thead><tr><th>指标</th><th>权重</th><th v-if="peer">匿名他评</th><th v-if="self">我的自评</th></tr></thead><tbody><tr v-for="row in rows" :key="row.key"><td>{{row.label}}</td><td>{{row.weight??'未提供'}}</td><td v-if="peer">{{formatReportScore(row.peer)}}</td><td v-if="self">{{formatReportScore(row.self)}}</td></tr></tbody></table></div></template>
<style scoped>.dimension-chart{min-width:0}.dimension-chart svg{display:block;width:100%;height:auto;overflow:visible}.dimension-chart g:focus{outline:2px solid #a9c9ff;outline-offset:4px}.sr-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media screen and (max-width:560px){.dimension-chart svg{display:none}.sr-only{position:static;width:100%;height:auto;padding:0;overflow:visible;clip:auto;white-space:normal;border-collapse:collapse;table-layout:fixed;font-size:12px}.sr-only caption{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.sr-only th,.sr-only td{padding:9px 5px;border-bottom:1px solid #e5eaf2;text-align:left;overflow-wrap:anywhere}.sr-only th{color:#667085;font-weight:500}}
</style>
