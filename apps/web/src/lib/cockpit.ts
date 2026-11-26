import type { ComposeOption } from 'echarts/core';
import type { LineSeriesOption } from 'echarts/charts';
import type { GridComponentOption, LegendComponentOption, TooltipComponentOption } from 'echarts/components';
export interface CockpitCycle {id:string;title:string;month:string;status:string;open_at:string|null;close_at:string|null;participants:number;materials:number;self_submitted:number;peer_expected:number;peer_submitted:number;materialRate:number|null;selfRate:number|null;peerRate:number|null;overallRate:number|null}
export interface DepartmentProgress {id:string|null;name:string;participants:number;done:number;expected:number;rate:number|null}
export interface CockpitTodo {key:string;label:string;count:number;capability:string;to:string}
export interface TrendPoint {cycle_id:string;month:string;title:string;dimension:string;value:number;sample_count:number}
export interface CockpitData {cycles:CockpitCycle[];cycle:CockpitCycle|null;departments:DepartmentProgress[];todos:CockpitTodo[];trend:TrendPoint[];permissions:string[]}
export const percent=(value:number|null|undefined)=>value==null?'—':`${Math.round(value*100)}%`;
export function deadlineText(cycle:Pick<CockpitCycle,'status'|'open_at'|'close_at'>,now:number) {
 if(cycle.status==='CANCELLED')return '周期已撤销';
 if(cycle.status==='ARCHIVED')return '周期已归档';
 if(cycle.status==='PUBLISHED')return '结果已发布';
 if(cycle.status==='DRAFT')return '草稿 · 尚未开放';
 const open=cycle.open_at?Date.parse(cycle.open_at):NaN,close=cycle.close_at?Date.parse(cycle.close_at):NaN;
 if(['CALIBRATING','PARTIALLY_PUBLISHED'].includes(cycle.status)||Number.isFinite(close)&&now>=close)return '评价已截止';
 if(cycle.status==='PENDING_OPEN'||Number.isFinite(open)&&now<open)return Number.isFinite(open)?`距离开始 ${Math.max(0,Math.ceil((open-now)/86400000))} 天`:'尚未开始';
 return Number.isFinite(close)?`距离截止还有 ${Math.ceil((close-now)/86400000)} 天`:'截止时间尚未设置';
}
export type GrowthChartOption=ComposeOption<LineSeriesOption|GridComponentOption|LegendComponentOption|TooltipComponentOption>;
export function growthChart(points:TrendPoint[]):GrowthChartOption {
 const cycles=[...new Map(points.map(p=>[p.cycle_id,{month:p.month,title:p.title}])).entries()];
 const dimensions=[...new Set(points.map(p=>p.dimension))];
 return {color:['#246bfd','#14a9a4','#8a5be8','#ef9a35'],animationDuration:350,
  textStyle:{fontFamily:'inherit',color:'#64748b'},grid:{top:46,left:38,right:18,bottom:34},
  tooltip:{trigger:'axis',renderMode:'richText',valueFormatter:v=>v==null?'暂无数据':`${Number(v).toFixed(2)}`},
  legend:{top:0,type:'scroll',textStyle:{fontSize:11}},
  xAxis:{type:'category',data:cycles.map(([,c])=>c.month),boundaryGap:false,axisLine:{lineStyle:{color:'#e4eaf3'}},axisTick:{show:false}},
  yAxis:{type:'value',min:0,max:100,splitLine:{lineStyle:{color:'#edf1f7'}},axisLabel:{fontSize:11}},
  series:dimensions.map((name,i)=>({name,type:'line',smooth:0.25,connectNulls:false,symbol:'circle',symbolSize:6,lineStyle:{width:2},
   areaStyle:i===0?{opacity:0.07}:undefined,data:cycles.map(([id])=>points.find(p=>p.cycle_id===id&&p.dimension===name)?.value??null)}))};
}
