import type {Participant} from './types.js';
export const ASSIGNMENT_MAX_INDEGREE=5;
export const ASSIGNMENT_MAX_OUTDEGREE=5;
/** Existing policy: same department, with the existing head-to-head exception. */
export function assignmentEdgeIssue(people:Participant[],edges:Array<{reviewerId:string;targetId:string}>,reviewerId:string,targetId:string,allowCrossDepartment=false):string|null{
 const reviewer=people.find(p=>p.userId===reviewerId),target=people.find(p=>p.userId===targetId);
 if(!reviewer||!target||![reviewer.role,target.role].every(r=>r==='HEAD'||r==='MEMBER'))return 'ASSIGNMENT_PARTICIPANT_INVALID';
 if(reviewerId===targetId)return 'SELF_REPLACEMENT_FORBIDDEN';
 if(!allowCrossDepartment&&reviewer.deptId!==target.deptId&&!(reviewer.role==='HEAD'&&target.role==='HEAD'))return 'CROSS_DEPARTMENT_NOT_CONFIGURED';
 if(edges.some(e=>e.reviewerId===reviewerId&&e.targetId===targetId))return 'ASSIGNMENT_EDGE_EXISTS';
 if(edges.filter(e=>e.reviewerId===reviewerId).length>=ASSIGNMENT_MAX_OUTDEGREE||edges.filter(e=>e.targetId===targetId).length>=ASSIGNMENT_MAX_INDEGREE)return 'ASSIGNMENT_CAPACITY_EXCEEDED';
 return null;
}
