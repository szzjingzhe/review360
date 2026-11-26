<script setup lang="ts">
import { computed, ref } from 'vue';
import { scoreError } from '../lib/selfReview';
/** 分数输入：文本输入 + 步进按钮，输入即刻回写，避免 number 输入框在空值时点箭头无反应。 */
const props=defineProps<{modelValue:string;label:string;disabled?:boolean;id:string}>();
const emit=defineEmits<{ 'update:modelValue':[string]; invalid:[boolean] }>();
const el=ref<HTMLInputElement|null>(null);
const error=computed(()=>scoreError(props.modelValue));
const shown=computed(()=>props.modelValue);
function apply(raw:string):string{
  const clean=raw.replace(/[^\d.]/g,'').slice(0,4);
  const value=clean!==''&&Number(clean)>100?'100':clean;
  emit('update:modelValue',value);
  emit('invalid',false);
  return value;
}
function onInput(event:Event){
  const target=event.target as HTMLInputElement;
  const applied=apply(target.value);
  if(applied!==target.value)target.value=applied;
}
function step(direction:number){
  if(props.disabled)return;
  const current=props.modelValue.trim()===''?NaN:Number(props.modelValue);
  const base=Number.isFinite(current)?current:80;
  apply(String(Math.min(100,Math.max(0,Math.round(base)+direction))));
  el.value?.focus();
}
function onKeydown(event:KeyboardEvent){
  if(event.key==='ArrowUp'){event.preventDefault();step(1);}
  else if(event.key==='ArrowDown'){event.preventDefault();step(-1);}
}
</script>
<template>
 <div class="score-input">
  <div class="score-row">
   <div class="control" :class="{invalid:!!error,disabled}">
    <button type="button" class="step" :disabled="disabled" aria-label="减少 1 分" tabindex="-1" @click="step(-1)">−</button>
    <input :id="id" ref="el" :aria-label="label+'分数'" :aria-describedby="id+'-hint'" type="text" inputmode="numeric" autocomplete="off" maxlength="4" placeholder="未评分" :value="shown" :disabled="disabled" :aria-invalid="!!error" @input="onInput" @keydown="onKeydown"/>
    <button type="button" class="step" :disabled="disabled" aria-label="增加 1 分" tabindex="-1" @click="step(1)">＋</button>
   </div>
   <span class="suffix">/ 100 分</span>
  </div>
  <small v-if="error" :id="id+'-hint'" class="error" role="status">{{error}}</small>
  <span v-else :id="id+'-hint'" class="sr-only">0–100 分，整数；可用输入框两侧的加减按钮按 1 分调整，未评分与 0 分分别记录。</span>
 </div>
</template>
<style scoped>
.score-input{width:230px;max-width:100%;flex:none}
.score-row{display:flex;align-items:center;gap:10px}
.control{display:flex;align-items:center;flex:1;min-width:0;height:40px;border:1px solid #d8e1ee;border-radius:7px;background:#fff;overflow:hidden;transition:border-color .15s,box-shadow .15s}
.control:focus-within{border-color:#246bfd;box-shadow:0 0 0 3px #246bfd1a}
.control .step{flex:0 0 30px;height:100%;padding:0;border:0;background:#f5f8ff;color:#246bfd;font-size:16px;line-height:1;cursor:pointer;transition:background .15s}
.control .step:hover:not(:disabled){background:#e8f0ff}
.control .step:active:not(:disabled){background:#dbe7ff}
.control .step:disabled{color:#a8b5c8;background:#f8fafc;cursor:not-allowed}
.control input{box-sizing:border-box;flex:1;min-width:0;width:100%;height:100%;padding:0 6px;border:0;outline:0;text-align:center;font-family:inherit;font-size:15px;font-weight:600;color:#172b4d;background:transparent;-moz-appearance:textfield;appearance:textfield}
.control input::-webkit-outer-spin-button,.control input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.control input::placeholder{color:#98a2b3;font-weight:400;font-size:13px}
.suffix{flex:none;font-size:12px;white-space:nowrap;color:#667085}
.control.disabled{background:#f7f9fc;border-color:#e5eaf2}
.control input:disabled{color:#8492a8;cursor:not-allowed}
.control.invalid{border-color:#d34b4b}
.control.invalid:focus-within{box-shadow:0 0 0 3px #d34b4b1a}
.error{display:block;margin-top:6px;text-align:right;color:#b42318;font-size:12px;line-height:1.5}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
</style>
