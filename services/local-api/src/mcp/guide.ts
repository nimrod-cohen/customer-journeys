// The reference text the `get_authoring_guide` tool returns, so an assistant can
// write valid automation definitions, rules and broadcasts without guessing.
// Keep in step with automation-runner/src/dsl.ts + exit-rules-dsl.ts.
export const AUTHORING_GUIDE = `# Customer Journeys — authoring guide

## What you can and cannot do
You can READ the workspace's automations, broadcasts, segments, templates, topics,
senders and event names, and you can CREATE and EDIT DRAFTS. You cannot publish an
automation, enroll people, send or schedule a broadcast, or delete anything — a
person does those in the app (Automations → Save & publish; Broadcasts → Schedule/Send).
Tell the user which step is left for them.

## Automation definition (JSON)
{ "startNode": "<id>", "nodes": { "<id>": Node, ... }, "exitRules": [ExitRule, ...] }
- Exactly ONE trigger node; startNode is the trigger's id.
- A DOWNWARD tree: no cycles, no orphans (every node reachable from the trigger), at
  least one reachable "exit". Two branches may re-join on the same node.
- Node ids are any short unique strings ("t", "send1", "wait2", ...).

### Node types
- Trigger: {"type":"trigger","kind":"segment_entry"|"event"|"profile"|"manual","next":"<id>", "label"?}
  - event: "eventType" (required) + optional "filter" (payload rule, see Rules — fields "payload.<key>").
  - profile: "profileChange": "created"|"updated"|"any".
  - segment_entry: the segment is NOT on the node — pass trigger_segment_id (+ trigger_on "enter"|"exit")
    to create_automation / save_automation_draft.
- Wait: {"type":"wait","delay":{"seconds":86400},"next":"<id>"}
  Rich wait-until (any of): "until" (ISO date-time; no offset = workspace timezone),
  "untilOffset": {"amount":1,"unit":"minutes"|"hours"|"days","anchor":"now"|"{{event.appointment_at}}","direction":"after"|"before"},
  "waitCondition": Rule, "combine":"and"|"or", "maxWait":{"amount":3,"unit":"days"}.
- Time window: {"type":"hour_of_day_window","startHour":9,"endHour":17,"daysOfWeek"?:[1,2,3,4,5],"next":"<id>"}
  (hours 0-23, workspace timezone; start > end wraps overnight).
- If/else: {"type":"condition","ast":Rule,"onTrue":"<id>","onFalse":"<id>","label"?}
- Send email: {"type":"action","kind":"send","medium":"email","template_id"?:"<id>","topic_id"?:"<id>","next":"<id>"}
  Leave template_id out, save the draft, then call attach_email_to_automation_step — it makes
  the node's own copy of a library template. Then set its subject/From with set_email_envelope.
- Send SMS / WhatsApp: {"type":"action","kind":"send","medium":"sms"|"whatsapp","text_body":"Hi {{customer.first_name}}","next":"<id>"}
- Update profile: {"type":"action","kind":"set_attribute","assignments":[{"key":"tier","value":{"kind":"literal","value":"gold"}}],"next":"<id>"}
  value kinds: {"kind":"literal","value":…} | {"kind":"expression","expression":"{{event.plan}}"}.
- Journey variable: same shape with "kind":"set_journey" (readable later as {{journey.<key>}}).
- Webhook: {"type":"action","kind":"webhook","url":"https://…","method":"POST","bodyTemplate"?:"…","next":"<id>"}
  (hosts must be on the workspace allowlist).
- Exit: {"type":"exit"}

### Exit rules (optional) — leave or restart while enrolled
{"id":"bought","label"?:"Bought","action":"exit"|"restart","when": When}
When = {"kind":"event","eventType":"purchase","eventTypes"?:["purchase","refund"],"filter"?:Rule}
     | {"kind":"segment_exit","segmentId":"<id>"} | {"kind":"segment_entry","segmentId":"<id>"}
     | {"kind":"profile_match","ast":Rule}
"exit" ends the journey and cancels its pending messages; "restart" sends the person back to
the start (journey variables cleared). A profile_match restart fires only when the condition
BECOMES true. Rules take effect when the automation is published. With "eventTypes", ANY of
those events fires the rule ("eventType" must be the first of them). Someone who unsubscribes
from everything leaves every automation automatically — no rule needed.

## Rules (segments, If/else, waits, broadcast audiences)
Leaf: {"field":"<field>","operator":"=","value":…}
Group: {"op":"and"|"or"|"not","conditions":[Rule,...]}
Operators: = != > >= < <= in "not in" between exists "not exists" contains "not contains"
"starts with" "ends with" (in/not in take an array; between takes [low, high]).
Fields: "email", "phone", "created_at", "attributes.<key>" (shorthand "customer.<key>"),
rolling features such as "total_events". Event leaf: {"event":"purchase"} (did it at least once)
or {"event":"purchase","operator":">=","value":3,"withinDays"?:30}; add "negate":true for
"never did". Segment membership: {"segment":"<segment id>","negate"?:true}. Inside an
automation also: {"triggerEvent":true,"filter":Rule over "payload.<key>"} and
{"journeyKey":"<key>","operator":"=","value":…}.

## Merge tags
{{customer.<field or attribute>}}, {{event.<payload path>}} (the event that enrolled them),
{{journey.<key>}}, {{unsubscribe}} (email body).

## Broadcasts
A broadcast is a one-off send to an audience (a Rule, or a segment id). Drafts you create
are never scheduled; a person schedules or sends them. Email broadcasts need a template copy
(create_broadcast with template_id clones it) and an envelope (From = a sender id from
list_senders, subject) — set with set_email_envelope.
`;
