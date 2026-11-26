<script setup lang="ts">
import {useRoute} from 'vue-router';
import {MONTHLY_SECTIONS,monthlyPath} from '../lib/monthly-navigation';
import CockpitIcon from './CockpitIcon.vue';
const route=useRoute();
</script>
<template><nav class="monthly-navigation" aria-label="月评管理二级导航"><RouterLink v-for="s in MONTHLY_SECTIONS" :key="s.key" :to="{path:monthlyPath(s.key),query:route.params.cycleId?{cycleId:String(route.params.cycleId)}:route.query.cycleId?{cycleId:route.query.cycleId}:{}}" :class="{selected:(route.params.section??'cycles')===s.key}" :aria-current="(route.params.section??'cycles')===s.key?'page':undefined"><CockpitIcon :name="s.icon"/>{{s.label}}</RouterLink></nav></template>
<style scoped>.monthly-navigation{display:flex;gap:18px;align-items:center;overflow:auto;border-bottom:1px solid #e6edf6;margin:4px 0 24px;padding:0 0 9px}.monthly-navigation a{display:flex;align-items:center;gap:9px;padding:12px 16px;text-decoration:none;color:#526581;font-size:14px;white-space:nowrap;border-radius:8px;position:relative}.monthly-navigation svg{width:19px;height:19px}.monthly-navigation a:not(.selected):hover{background:#f4f8ff}.monthly-navigation a.selected{background:#edf4ff;color:#246bfd;font-weight:600}.monthly-navigation a.selected:after{content:'';position:absolute;bottom:-10px;height:2px;left:16px;right:16px;background:#3370ff}@media(max-width:760px){.monthly-navigation{gap:4px}.monthly-navigation a{padding:11px 12px;font-size:13px}}</style>
