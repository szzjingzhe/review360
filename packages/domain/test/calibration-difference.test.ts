import {describe,it,expect} from 'vitest';
import {assessSelfPeerDifference} from '../src/calibration/difference.js';
const configured={minReviews:2,mediumPoints:15,highPoints:25};
describe('自评与有效他评差异',()=>{
 it('规则未配置时不触发',()=>expect(assessSelfPeerDifference(9500,[7000,7000]).status).toBe('NOT_CONFIGURED'));
 it('少于两份时样本不足',()=>expect(assessSelfPeerDifference(9500,[7000],configured).status).toBe('INSUFFICIENT'));
 it('达到 15 和 25 分的边界分级',()=>{
  expect(assessSelfPeerDifference(8500,[7000,7000],configured)).toMatchObject({status:'TRIGGERED',severity:'MEDIUM',differencePoints:15});
  expect(assessSelfPeerDifference(9500,[7000,7000],configured)).toMatchObject({status:'TRIGGERED',severity:'HIGH',differencePoints:25});
  expect(assessSelfPeerDifference(8499,[7000,7000],configured).status).toBe('NORMAL');
 });
 it('支持后端配置并拒绝无效配置',()=>{
  expect(assessSelfPeerDifference(9000,[7000,7000],{minReviews:2,mediumPoints:21,highPoints:30}).status).toBe('NORMAL');
  expect(()=>assessSelfPeerDifference(9000,[7000,7000],{minReviews:1,mediumPoints:15,highPoints:25})).toThrow('DIFFERENCE_RULE_INVALID');
 });
});
