export const capabilityLabels:Record<string,string>={
 'management.access':'管理端入口','workspace.oversight':'管理工作台入口','workspace.department':'部长工作台（部门管理端）','cycle.manage':'月评周期管理',
 'assignment.manage':'评价关系管理','progress.read':'评价进度查看','reminder.send':'催办提醒',
 'calibration.read_raw':'原始评价及身份读取（独立敏感授权）','calibration.resolve':'异常核验处理',
 'result.read_published':'正式发布成绩查看','result.read_aggregate':'核算结果查看','result.confirm':'结果确认',
 'result.publish':'结果发布','growth.manage':'成长分析生成与核对','feedback.manage':'反馈申诉处理',
 'report.view':'月报洞察查看','org.manage':'组织与权限管理','audit.export':'操作日志导出','award.manage':'历史评优管理',
};
const eventLabels:Record<string,string>={'AUTH_LOGIN':'登录','AUTH_LOGOUT':'退出登录','result.build':'结果核算','result.publish':'结果发布',
 'growth.generate':'生成成长分析','growth.confirm':'确认成长分析','growth.failed':'成长分析生成失败',
 'cycle.cancelled':'撤销月评','cycle.archived':'归档月评','cycle.confirm_open':'确认开期','cycle.create':'创建周期',
 'ruleset.edit':'编辑规则草稿','ruleset.freeze':'冻结规则','ruleset.delete_draft':'删除规则草稿',
 'capability.grant':'授予权限','capability.revoke':'撤销权限','authorization.denied':'权限拒绝','authorization.raw_access':'敏感评价读取'};
export const auditLabel=(code:string)=>eventLabels[code]??'业务操作';
