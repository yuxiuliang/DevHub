use std::collections::{HashMap, HashSet};

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Map, Value};

use crate::adapters::is_worker;
use crate::models::{now, uid};
use crate::store::Store;

#[derive(Debug)]
pub struct SettingsError {
    pub status: u16,
    pub message: String,
}

impl SettingsError {
    fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(409, message)
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(400, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(404, message)
    }

    fn bad(message: impl Into<String>) -> Self {
        Self::new(400, message)
    }

    fn missing(message: impl Into<String>) -> Self {
        Self::new(404, message)
    }
}

impl std::fmt::Display for SettingsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SettingsError {}

fn object(value: &Value) -> Result<&Map<String, Value>, SettingsError> {
    value
        .as_object()
        .ok_or_else(|| SettingsError::bad("设置必须是完整的设置对象"))
}

fn required_text<'a>(
    value: Option<&'a Value>,
    label: &str,
    allow_empty: bool,
) -> Result<&'a str, SettingsError> {
    let text = value
        .and_then(Value::as_str)
        .ok_or_else(|| SettingsError::bad(format!("{label}必须是文字")))?;
    if !allow_empty && text.trim().is_empty() {
        return Err(SettingsError::bad(format!("{label}不能为空")));
    }
    Ok(text)
}

fn current_settings(tx: &rusqlite::Connection, room_id: &str) -> Result<Value, SettingsError> {
    let row: Option<(String, String, String, i64, Option<String>, Option<String>, String)> = tx
        .query_row(
            "SELECT name,requirement,mode,auto_approve,planner_id,reviewer_id,status FROM rooms WHERE id=?",
            [room_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
        )
        .optional()
        .map_err(|e| SettingsError::new(500, e.to_string()))?;
    let Some((name, requirement, mode, auto_approve, planner_id, reviewer_id, status)) = row else {
        return Err(SettingsError::missing("会话不存在，请刷新后重新选择"));
    };
    let mut stmt = tx
        .prepare("SELECT id,name,worker,role_name,role_brief,model,concurrency,enabled FROM members WHERE room_id=? ORDER BY sort,name")
        .map_err(|e| SettingsError::new(500, e.to_string()))?;
    let members = stmt
        .query_map([room_id], |row| {
            let id: String = row.get(0)?;
            Ok(json!({
                "key": id,
                "id": id,
                "name": row.get::<_,String>(1)?,
                "worker": row.get::<_,String>(2)?,
                "role_name": row.get::<_,Option<String>>(3)?.unwrap_or_default(),
                "role_brief": row.get::<_,Option<String>>(4)?.unwrap_or_default(),
                "model": row.get::<_,Option<String>>(5)?.unwrap_or_default(),
                "concurrency": row.get::<_,i64>(6)?,
                "enabled": row.get::<_,i64>(7)? != 0,
            }))
        })
        .map_err(|e| SettingsError::new(500, e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| SettingsError::new(500, e.to_string()))?;
    let settings = json!({
        "name": name,
        "requirement": requirement,
        "mode": mode,
        "autoApprove": auto_approve != 0,
        "plannerKey": planner_id.unwrap_or_default(),
        "reviewerKey": reviewer_id.unwrap_or_default(),
        "members": members,
    });
    Ok(json!({
        "roomId": room_id,
        "archived": status == "archived",
        "version": settings.to_string(),
        "settings": settings,
    }))
}

pub fn read(store: &Store, room_id: &str) -> Result<Value, SettingsError> {
    let conn = store.db.lock().unwrap();
    current_settings(&conn, room_id)
}

fn validate(input: &Value, current: &Value) -> Result<Value, SettingsError> {
    let input = object(input)?;
    let name = required_text(input.get("name"), "会话名", false)?
        .trim()
        .to_string();
    let requirement = required_text(input.get("requirement"), "需求", true)?.to_string();
    let mode = required_text(input.get("mode"), "执行方式", false)?;
    if !["serial", "parallel"].contains(&mode) {
        return Err(SettingsError::bad("执行方式必须是 serial 或 parallel"));
    }
    let auto_approve = input
        .get("autoApprove")
        .and_then(Value::as_bool)
        .ok_or_else(|| SettingsError::bad("自动执行设置必须是开或关"))?;
    let submitted = input
        .get("members")
        .and_then(Value::as_array)
        .filter(|members| !members.is_empty())
        .ok_or_else(|| SettingsError::bad("至少保留一位成员"))?;
    let current_members = current["settings"]["members"]
        .as_array()
        .expect("canonical members");
    let current_by_id: HashMap<&str, &Value> = current_members
        .iter()
        .filter_map(|m| Some((m["id"].as_str()?, m)))
        .collect();
    let mut keys = HashSet::new();
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    let mut members = Vec::with_capacity(submitted.len());
    for (index, value) in submitted.iter().enumerate() {
        let label = format!("成员 {}", index + 1);
        let m = object(value).map_err(|_| SettingsError::bad(format!("{label}设置无效")))?;
        let key = required_text(m.get("key"), &format!("{label}标识"), false)?.to_string();
        if !keys.insert(key.clone()) {
            return Err(SettingsError::bad("成员标识重复，请重新打开设置后重试"));
        }
        let id = match m.get("id") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if s.is_empty() => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(_) => return Err(SettingsError::bad(format!("{label} ID 无效"))),
        };
        if let Some(id) = &id {
            if !current_by_id.contains_key(id.as_str()) {
                return Err(SettingsError::bad(
                    "提交的成员不属于当前会话，请重新打开设置后重试",
                ));
            }
            if key != *id {
                return Err(SettingsError::bad(
                    "已有成员标识不能修改，请重新打开设置后重试",
                ));
            }
            if !ids.insert(id.clone()) {
                return Err(SettingsError::bad("同一成员不能重复提交"));
            }
        } else if current_by_id.contains_key(key.as_str()) {
            return Err(SettingsError::bad(
                "新增成员标识与已有成员冲突，请重新打开设置后重试",
            ));
        }
        let member_name = required_text(m.get("name"), &format!("{label}名字"), false)?
            .trim()
            .to_string();
        if !names.insert(member_name.clone()) {
            return Err(SettingsError::bad(format!(
                "成员名字「{member_name}」重复，请使用不同的名字"
            )));
        }
        let worker = required_text(m.get("worker"), &format!("{label}工具"), false)?.to_string();
        if !is_worker(&worker) {
            return Err(SettingsError::bad(format!("未知协作工具：{worker}")));
        }
        let concurrency = m
            .get("concurrency")
            .and_then(Value::as_f64)
            .filter(|n| (1.0..=10.0).contains(n) && n.fract() == 0.0)
            .map(|n| n as i64)
            .ok_or_else(|| SettingsError::bad(format!("{label}的并发数必须是 1 到 10 的整数")))?;
        let enabled = m
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| SettingsError::bad(format!("{label}的启用状态必须是开或关")))?;
        let optional_text = |key: &str| -> Result<String, SettingsError> {
            match m.get(key) {
                None => Ok(String::new()),
                Some(Value::String(text)) => {
                    if key == "model" && text.chars().any(char::is_control) {
                        return Err(SettingsError::bad(format!(
                            "{label}的模型名不能包含换行或控制字符"
                        )));
                    }
                    Ok(text.trim().to_string())
                }
                Some(_) => Err(SettingsError::bad(format!("{label}的{key}必须是文字"))),
            }
        };
        let model = optional_text("model")?;
        let role_name = optional_text("role_name")?;
        let role_brief = optional_text("role_brief")?;
        members.push(json!({"key":key,"id":id,"name":member_name,"worker":worker,
            "role_name":role_name,"role_brief":role_brief,"model":model,"concurrency":concurrency,"enabled":enabled}));
    }
    let assigned = |field: &str, label: &str| -> Result<String, SettingsError> {
        let key = required_text(input.get(field), label, false)?;
        let member = members
            .iter()
            .find(|m| m["key"].as_str() == Some(key))
            .ok_or_else(|| SettingsError::bad(format!("{label}必须选择当前成员")))?;
        if member["enabled"].as_bool() != Some(true) {
            return Err(SettingsError::bad(format!(
                "{label}已停用，请选择启用的成员"
            )));
        }
        Ok(key.to_string())
    };
    let planner = assigned("plannerKey", "计划者")?;
    let reviewer = assigned("reviewerKey", "评审者")?;
    Ok(
        json!({"name":name,"requirement":requirement,"mode":mode,"autoApprove":auto_approve,
        "plannerKey":planner,"reviewerKey":reviewer,"members":members}),
    )
}

pub fn save(store: &Store, room_id: &str, input: &Value) -> Result<Value, SettingsError> {
    let mut conn = store.db.lock().unwrap();
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| SettingsError::new(500, e.to_string()))?;
    let current = current_settings(&tx, room_id)?;
    if current["archived"].as_bool() == Some(true) {
        return Err(SettingsError::conflict("会话已归档，请先恢复后再保存设置"));
    }
    let wrapper = object(input)?;
    let version = required_text(wrapper.get("version"), "设置版本", false)?;
    if current["version"].as_str() != Some(version) {
        return Err(SettingsError::conflict(
            "设置已在其他地方更新，请重新加载最新设置后再保存",
        ));
    }
    let settings = validate(
        wrapper
            .get("settings")
            .ok_or_else(|| SettingsError::bad("缺少设置内容"))?,
        &current,
    )?;
    let members = settings["members"].as_array().expect("validated members");
    let old = current["settings"]["members"]
        .as_array()
        .expect("canonical members");
    for member in members.iter().filter(|m| m["id"].is_null()) {
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM members WHERE id=?)",
                [member["key"].as_str().unwrap()],
                |row| row.get(0),
            )
            .map_err(|e| SettingsError::new(500, e.to_string()))?;
        if exists {
            return Err(SettingsError::bad(
                "新增成员标识与已有成员冲突，请重新打开设置后重试",
            ));
        }
    }
    let old_ids: HashSet<&str> = old.iter().filter_map(|m| m["id"].as_str()).collect();
    let new_ids: HashSet<&str> = members.iter().filter_map(|m| m["id"].as_str()).collect();
    for removed in old_ids.difference(&new_ids) {
        let owned: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE owner_id=?",
                [*removed],
                |r| r.get(0),
            )
            .map_err(|e| SettingsError::new(500, e.to_string()))?;
        if owned > 0 {
            let name = old
                .iter()
                .find(|m| m["id"].as_str() == Some(removed))
                .and_then(|m| m["name"].as_str())
                .unwrap_or("成员");
            return Err(SettingsError::bad(format!(
                "「{name}」名下还有 {owned} 个任务，不能删除；可以先停用"
            )));
        }
    }
    let mut ids = HashMap::new();
    for (sort, member) in members.iter().enumerate() {
        let key = member["key"].as_str().unwrap_or_default();
        let id = member["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| uid("m"));
        ids.insert(key.to_string(), id.clone());
        if old_ids.contains(id.as_str()) {
            tx.execute("UPDATE members SET name=?,worker=?,role_name=?,role_brief=?,model=?,concurrency=?,enabled=?,sort=? WHERE id=? AND room_id=?",
                params![member["name"].as_str().unwrap(),member["worker"].as_str().unwrap(),member["role_name"].as_str().unwrap(),member["role_brief"].as_str().unwrap(),member["model"].as_str().unwrap(),member["concurrency"].as_i64().unwrap(),if member["enabled"].as_bool().unwrap(){1}else{0},sort as i64,id,room_id])
                .map_err(|e|SettingsError::new(500,e.to_string()))?;
        } else {
            tx.execute("INSERT INTO members (id,room_id,name,worker,role_name,role_brief,model,concurrency,enabled,sort) VALUES (?,?,?,?,?,?,?,?,?,?)",
                params![id,room_id,member["name"].as_str().unwrap(),member["worker"].as_str().unwrap(),member["role_name"].as_str().unwrap(),member["role_brief"].as_str().unwrap(),member["model"].as_str().unwrap(),member["concurrency"].as_i64().unwrap(),if member["enabled"].as_bool().unwrap(){1}else{0},sort as i64])
                .map_err(|e|SettingsError::new(500,e.to_string()))?;
        }
    }
    for removed in old_ids.difference(&new_ids) {
        tx.execute(
            "DELETE FROM members WHERE id=? AND room_id=?",
            params![removed, room_id],
        )
        .map_err(|e| SettingsError::new(500, e.to_string()))?;
    }
    let planner = ids.get(settings["plannerKey"].as_str().unwrap()).unwrap();
    let reviewer = ids.get(settings["reviewerKey"].as_str().unwrap()).unwrap();
    tx.execute("UPDATE rooms SET name=?,requirement=?,mode=?,auto_approve=?,planner_id=?,reviewer_id=?,updated_at=? WHERE id=?",
        params![settings["name"].as_str().unwrap(),settings["requirement"].as_str().unwrap(),settings["mode"].as_str().unwrap(),if settings["autoApprove"].as_bool().unwrap(){1}else{0},planner,reviewer,now(),room_id])
        .map_err(|e|SettingsError::new(500,e.to_string()))?;
    let result = current_settings(&tx, room_id)?;
    tx.commit()
        .map_err(|e| SettingsError::new(500, e.to_string()))?;
    Ok(result)
}
