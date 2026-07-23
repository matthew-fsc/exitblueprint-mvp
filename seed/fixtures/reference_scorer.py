#!/usr/bin/env python3
"""Generates the Exit Blueprint seed folder from the DRS methodology (Blueprint II).

Output directory defaults to the repository's own seed/ folder (two levels up
from this file); override with the SEED_OUT environment variable.
"""
import json, csv, os, math

OUT = os.environ.get(
    "SEED_OUT",
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..")),
)
os.makedirs(f"{OUT}/fixtures", exist_ok=True)
os.makedirs(f"{OUT}/playbooks", exist_ok=True)

# ---------------- DIMENSIONS ----------------
dimensions = [
    # code, name, score_group, drs_weight, sort
    ("REV", "Revenue Quality", "business_readiness", 0.25, 1),
    ("FIN", "Financial Integrity", "business_readiness", 0.20, 2),
    ("OPS", "Operational Independence", "business_readiness", 0.20, 3),
    ("CUS", "Customer Risk", "business_readiness", 0.15, 4),
    ("MGT", "Management and Team", "business_readiness", 0.10, 5),
    ("GRW", "Growth Drivers", "business_readiness", 0.10, 6),
    ("GOL", "Exit Goals and Timing", "owner_readiness", 0.0, 7),
    ("PFN", "Personal Financial Readiness", "owner_readiness", 0.0, 8),
    ("VAL", "Value Confidence", "owner_readiness", 0.0, 9),
]

# ---------------- QUESTIONS (intake inputs) ----------------
# code, dimension, prompt, answer_type, options, scored(feeds a sub-score), sort
questions = [
    # REV inputs
    ("REV-RECUR-PCT","REV","What percentage of TTM revenue is contractually recurring or subscription/retainer based?","numeric","",True,1),
    ("REV-TOP5-SHARES","REV","List the top five customers' share of TTM revenue as percentages, largest first.","numeric_list","",True,2),
    ("REV-CONTRACT-CUST-PCT","REV","What percentage of active customers have a signed contract, MSA, or retainer in place?","numeric","",True,3),
    ("REV-CONTRACT-AVG-MO","REV","Average remaining contract term across contracted customers, in months.","numeric","",True,4),
    ("REV-ANNUAL","REV","Annual revenue for the last four fiscal years, oldest first.","numeric_list","",True,5),
    ("REV-NRR","REV","Net revenue retention for the most recent year (%). Enter 'unknown' if not tracked.","numeric_or_unknown","",True,6),
    ("REV-STREAMS-CTX","REV","Walk through the top three revenue streams: stability and what would cause each to decline.","text","",False,7),
    ("REV-PRICING-CTX","REV","How would revenue be impacted by a 10-15% price increase?","select","minimal_churn|some_churn|major_churn|unknown",False,8),
    ("REV-FOUNDER-CTX","REV","Which revenue streams depend on the founder's personal relationships?","text","",False,9),
    ("BIZ-AGE-YEARS","REV","How many years has the business been operating?","numeric","",False,10),
    ("REV-MODEL","REV","Which best describes the revenue model?","select","recurring|mixed|transactional_project|asset_rental",False,11),
    # FIN inputs
    ("FIN-RECON","FIN","How often are books reconciled against bank statements?","select","monthly|quarterly|annual|none",True,1),
    ("FIN-ADDBACK-DOC","FIN","How well documented are EBITDA addbacks (owner comp basis, personal expenses, one-time items)?","select","fully_documented|mostly_documented|partially_documented|undocumented",True,2),
    ("FIN-BASIS","FIN","Accounting basis and revenue recognition consistency.","select","accrual_consistent|cash_with_bridge|cash_mixed|unreconcilable",True,3),
    ("FIN-STATEMENTS","FIN","Which financial statements are produced and internally consistent?","select","all_three|pl_and_bs|pl_only|spreadsheet_only",True,4),
    ("FIN-HISTORY-CTX","FIN","Is 36+ months of financial history available?","select","yes_clean|yes_gaps|no",False,5),
    ("FIN-RELPARTY-CTX","FIN","Describe any related-party transactions (owner-affiliated rent, family salaries, affiliated vendors).","text","",False,6),
    ("FIN-ONETIME-CTX","FIN","Describe any one-time revenue items or non-recurring expenses in the reported period.","text","",False,7),
    ("FIN-DECLINE-CTX","FIN","If revenue declined in any year before recovering, explain the decline and what changed.","text","",False,8),
    # OPS inputs
    ("OPS-OWNER-HOURS","OPS","Owner hours per week in day-to-day operations (not strategy, not external).","numeric","",True,1),
    ("OPS-SOP-PCT","OPS","Percentage of core processes with written SOPs (sales, delivery, onboarding, invoicing, vendor mgmt).","numeric","",True,2),
    ("OPS-MGR-COUNT","OPS","How many core functions have a qualified manager who could run it without the owner?","numeric","",True,3),
    ("OPS-FUNC-COUNT","OPS","How many core business functions does the company have (default four: sales, delivery, finance, operations)?","numeric","",True,4),
    ("OPS-AUTO-PCT","OPS","Percentage of repetitive tasks (invoicing, reporting, scheduling) handled by systems rather than people.","numeric","",True,5),
    ("OPS-90DAY-CTX","OPS","What happens to the business if the owner is unavailable for 90 days?","text","",False,6),
    ("OPS-POSTCLOSE-CTX","OPS","Owner's intended post-close role and transition plan.","text","",False,7),
    ("OPS-KEYREL-CTX","OPS","Which customer relationships are personally owned by the founder vs institutionally managed?","text","",False,8),
    ("OPS-LICENSE-DEP","OPS","Does operating the business depend on a license, certification, CON, or franchise that may not transfer automatically to a buyer?","select","no|transfers_easily|requires_requalification|may_not_transfer",False,9),
    # CUS inputs (top1/top5 derived from REV-TOP5-SHARES)
    ("CUS-TENURE","CUS","Average length of an active customer relationship, in years.","numeric","",True,1),
    ("CUS-REV-CONTRACT-PCT","CUS","Percentage of active revenue covered by formal contracts.","numeric","",True,2),
    ("CUS-CHURN","CUS","Annual revenue churn rate from customer losses (%). ","numeric","",True,3),
    ("CUS-COC-CTX","CUS","Any termination-for-convenience or change-of-control clauses in key customer contracts?","select","none|some_unreviewed|yes_material",False,4),
    ("CUS-SIGNALS-CTX","CUS","Have any customers given notice they are evaluating alternatives or reducing scope?","select","no|one_minor|yes_material",False,5),
    ("CUS-TOP5-CTX","CUS","Top five customers: names and contract terms with each.","text","",False,6),
    # MGT inputs
    ("MGT-LAYERS","MGT","Management structure below the owner.","select","two_plus_layers|one_clear_layer|informal_partial|none_all_report_to_owner",True,1),
    ("MGT-NC-PCT","MGT","Percentage of key employees with signed non-compete/non-solicit agreements.","numeric","",True,2),
    ("MGT-COMP","MGT","Key-role total compensation vs market median.","select","within_15pct|below_15_25pct|below_25pct_plus|above_25pct_plus",True,3),
    ("MGT-TURNOVER","MGT","Voluntary annual turnover rate for non-owner employees (%), trailing 3 years.","numeric","",True,4),
    ("MGT-FLIGHT-CTX","MGT","Has any key manager indicated they would leave in the event of an acquisition?","select","no|unknown|yes",False,5),
    ("EMPLOYEE-COUNT","MGT","How many non-owner employees does the business have (full-time equivalent)?","numeric","",False,7),
    ("MGT-CFO-CTX","MGT","Who is responsible for the numbers (CFO, controller, bookkeeper, owner)?","text","",False,6),
    # GRW inputs (CAGR derived from REV-ANNUAL)
    ("GRW-PIPELINE","GRW","Estimated dollar value of qualified pipeline (identified need, budget, timeline). Enter 0 if no formal pipeline.","numeric","",True,1),
    ("GRW-POSITIONING","GRW","Market positioning: defined ICP, clear differentiation, repeatable sales motion.","select","strong_defined|moderate|undifferentiated_unclear",True,2),
    ("GRW-REPEAT-PCT","GRW","Percentage of revenue from standardized, repeatable offerings vs fully custom work.","numeric","",True,3),
    ("GRW-INVEST-CTX","GRW","What investments are required to sustain current growth?","text","",False,4),
    ("GRW-EXPAND-CTX","GRW","Untapped markets or geographies, and what limits expansion?","text","",False,5),
    # Owner readiness
    ("GOL-STAY","GOL","Do you want to stay on or leave after selling?","select","stay_longterm|transition_period|leave_immediately",False,1),
    ("GOL-PATH","GOL","Preferred exit path.","select","third_party|mgmt_employee|partner|family|step_back_retain",False,2),
    ("GOL-PRIORITIES","GOL","Rank outcome priorities.","rank","max_price|protect_employees|legacy|family_ownership|exit_quickly|reduce_risk|ongoing_income",False,3),
    ("GOL-TIMELINE","GOL","How quickly do you want to exit?","select","under_12mo|one_2yr|two_3yr|three_plus_yr",True,4),
    ("PFN-DEPEND","PFN","How dependent is your future lifestyle on achieving a specific sale price? (1 fully dependent - 5 not dependent)","scale_1_5","",True,1),
    ("PFN-OUTSIDE","PFN","Do you have sufficient assets outside the business to retire?","select","yes|mostly|partially|no",True,2),
    ("PFN-INCOME-CTX","PFN","Do you expect ongoing income from the business post-exit?","select","none_expected|earnout|seller_note|consulting|equity_rollover",False,3),
    ("PFN-DEBT","PFN","Are personal debt, guarantees, and lifestyle expenses consistent with your exit timeline?","select","yes|minor_issues|significant_issues",True,4),
    ("VAL-LASTVAL","VAL","When was the business last professionally valued?","select","within_12mo|one_3yr|over_3yr|never",True,1),
    ("VAL-CONF","VAL","How confident are you that business value supports your personal goals? (1-5)","scale_1_5","",True,2),
    ("VAL-SEP","VAL","Are personal expenses separate from the business?","select","fully|mostly|mixed",True,3),
    ("VAL-ASSETS-CTX","VAL","Significant assets that may need separate valuation?","select","none|real_estate|ip|equipment|other",False,4),
]

# ---------------- SUB-SCORES (Blueprint II bands, exact) ----------------
# code, dimension, name, weight, formula_type, inputs, bands/logic json, notes
subscores = [
    ("REV-RECUR","REV","Recurring Revenue Percentage",0.30,"band_gte","REV-RECUR-PCT",
     {"bands":[[80,100],[60,75],[40,50],[20,25],[0,0]],
      "na_when":{"answer_in":{"question_code":"REV-MODEL","values":["transactional_project","asset_rental"]}}},
     "Score=100 benchmark: >=80% recurring. N/A for transactional/project and asset-rental models, where recurring revenue is not the business shape."),
    ("REV-HHI","REV","Customer Concentration (HHI)",0.25,"hhi_from_top5","REV-TOP5-SHARES",
     {"bands_lt":[[1000,100],[1500,80],[2000,55],[2500,30],[4000,15],[6000,7]],"else":0,"cap_if_top1_gt":[30,60]},
     "HHI estimated as lower bound from top-5 shares (sum of squared %). DRS-2.0: gradient extended across the severe range. Cap 60 if top customer >30%."),
    ("REV-DURABILITY","REV","Contract Durability",0.20,"durability","REV-CONTRACT-CUST-PCT,REV-CONTRACT-AVG-MO",
     {"formula":"100*min(1,coverage/75)*min(1,months/18)",
      "na_when":{"answer_in":{"question_code":"REV-MODEL","values":["transactional_project","asset_rental"]}}},
     "Benchmark: >=75% contracted with >=18mo avg remaining. N/A for transactional/project and asset-rental models."),
    ("REV-GROWTH","REV","Revenue Growth Consistency",0.15,"growth_consistency","REV-ANNUAL",
     {"rules":"cagr>=15 and down==0 ->100; cagr>=10 and down<=1 ->75; cagr>=5 and down<=1 ->50; cagr>=0 ->25; cagr>=-5 and down<=1 ->15; else 0",
      "na_when":{"history_years_lt":3}},
     "CAGR over provided fiscal years; down = count of down years. DRS-2.0: mild steady decline earns 15 instead of 0. N/A below 3 fiscal years."),
    ("REV-NRR","REV","Churn Rate (NRR)",0.10,"band_gte","REV-NRR",
     {"bands":[[110,100],[100,80],[90,50],[80,25],[0,0]],"unknown":25,
      "na_when":{"answer_unknown":"REV-NRR","answer_in":{"question_code":"REV-MODEL","values":["transactional_project","asset_rental"]}}},
     "Known NRR bands as before. Not Applicable when 'unknown' (still raises a not-tracked flag) or for transactional/asset-rental models; excluded + re-normalized rather than scored at the worst band."),
    ("FIN-RECON","FIN","Audit Trail / Reconciliation",0.30,"select_map","FIN-RECON",
     {"map":{"monthly":100,"quarterly":65,"annual":30,"none":0}},""),
    ("FIN-ADDBACK","FIN","Addback Defensibility Index",0.30,"select_map","FIN-ADDBACK-DOC",
     {"map":{"fully_documented":100,"mostly_documented":70,"partially_documented":40,"undocumented":10}},
     "Questionnaire proxy for % of addback dollars rated LOW CHALLENGE (>=80% -> 100)."),
    ("FIN-GAAP","FIN","GAAP Proximity",0.20,"select_map","FIN-BASIS",
     {"map":{"accrual_consistent":100,"cash_with_bridge":60,"cash_mixed":25,"unreconcilable":0}},""),
    ("FIN-STATEMENTS","FIN","Statement Completeness",0.20,"select_map","FIN-STATEMENTS",
     {"map":{"all_three":100,"pl_and_bs":65,"pl_only":30,"spreadsheet_only":10}},""),
    ("OPS-HOURS","OPS","Owner Hours in Operations",0.35,"band_ascending","OPS-OWNER-HOURS",
     {"bands_lt":[[10,100],[20,75],[30,45],[40,20]],"else":0},"Lower is better. <10 hrs/week -> 100."),
    ("OPS-SOP","OPS","SOP Documentation Score",0.30,"band_gte","OPS-SOP-PCT",
     {"bands":[[80,100],[60,70],[40,40],[20,15],[0,0]]},""),
    ("OPS-DEPTH","OPS","Management Depth Ratio",0.20,"depth_ratio","OPS-MGR-COUNT,OPS-FUNC-COUNT",
     {"bands":[[1.0,100],[0.75,75],[0.5,40]],"else":10,"na_when":{"employee_count_lte":3}},
     "Ratio = qualified managers / core functions. N/A for an owner-operated business (<=3 non-owner employees): a management layer is not structurally possible."),
    ("OPS-AUTO","OPS","Process Automation Level",0.15,"band_gte","OPS-AUTO-PCT",
     {"bands":[[70,100],[50,70],[30,40],[0,15]]},""),
    ("CUS-TOP1","CUS","Top 1 Customer Revenue %",0.30,"top1_band","REV-TOP5-SHARES",
     {"bands_lt":[[10,100],[20,75],[30,45],[40,25],[50,15],[65,7]],"else":0,
      "anchor_offset":{"top1_gte":40,"coc_question":"CUS-COC-CTX","coc_ok":"none",
                       "months_question":"REV-CONTRACT-AVG-MO","min_months":24,"floor":45}},
     "DRS-2.0: gradient extended across the severe range so a single-customer business cannot plateau with a manageable one. A contractually locked-in anchor (no change-of-control clause, >=24mo avg term) floors at 45 rather than the fragile-whale score."),
    ("CUS-TOP5","CUS","Top 5 Customer Revenue %",0.25,"top5_band","REV-TOP5-SHARES",
     {"bands_lt":[[30,100],[45,75],[60,45],[75,25],[90,12]],"else":0},
     "DRS-2.0: gradient extended across the severe range."),
    ("CUS-TENURE","CUS","Average Customer Tenure",0.20,"band_gte","CUS-TENURE",
     {"bands":[[5,100],[3,75],[2,50],[1,25],[0,0]],"na_when":{"business_age_lt":5}},
     "N/A below 5 years in business: average tenure is bounded by company age, so a younger firm cannot attain the benchmark regardless of loyalty."),
    ("CUS-COVERAGE","CUS","Contract Coverage",0.15,"band_gte","CUS-REV-CONTRACT-PCT",
     {"bands":[[80,100],[60,70],[40,40],[0,10]]},""),
    ("CUS-CHURN","CUS","Annual Churn Rate",0.10,"band_ascending","CUS-CHURN",
     {"bands_lt":[[5,100],[10,70],[15,40],[20,15]],"else":0},"Lower is better."),
    ("MGT-LAYERS","MGT","Management Layers Below Owner",0.30,"select_map","MGT-LAYERS",
     {"map":{"two_plus_layers":100,"one_clear_layer":65,"informal_partial":30,"none_all_report_to_owner":0},
      "na_when":{"employee_count_lte":3}},
     "N/A for an owner-operated business (<=3 non-owner employees): no management layer is structurally possible."),
    ("MGT-NC","MGT","Key Person Non-Competes",0.25,"band_gte","MGT-NC-PCT",
     {"bands":[[100,100],[75,70],[50,35],[0,0]],"na_when":{"employee_count_lte":3}},
     "Flag enforceability jurisdiction in narrative. N/A for an owner-operated business: the relevant covenant is the OWNER's non-compete (a deal term), not key-employee agreements."),
    ("MGT-COMP","MGT","Compensation vs Market",0.25,"select_map","MGT-COMP",
     {"map":{"within_15pct":100,"below_15_25pct":50,"below_25pct_plus":0,"above_25pct_plus":70}},
     "Below market = flight risk; far above = cost structure risk."),
    ("MGT-RETENTION","MGT","Retention History",0.20,"band_ascending","MGT-TURNOVER",
     {"bands_lt":[[10,100],[15,70],[25,35]],"else":0,"na_when":{"business_age_lt":3,"employee_count_lte":3}},
     "Lower is better. N/A below 3 years in business (no history) or for an owner-operated business (no team to retain)."),
    ("GRW-CAGR","GRW","Revenue CAGR (3yr)",0.35,"cagr_band","REV-ANNUAL",
     {"bands":[[20,100],[15,85],[10,65],[5,40],[0,20],[-5,15],[-15,5]],"else":0,"na_when":{"history_years_lt":3}},
     "DRS-2.0: graded negative bands (soft -0..-5 -> 15, eroding -5..-15 -> 5, melting < -15 -> 0). N/A below 3 fiscal years."),
    ("GRW-PIPE","GRW","Pipeline Coverage Ratio",0.30,"pipeline_ratio","GRW-PIPELINE,REV-ANNUAL",
     {"bands":[[3,100],[2,70],[1,35],[0.5,15]],"else":0},
     "DRS-2.0: ratio = qualified pipeline / AVERAGE annual revenue (not the latest year), with graded credit at 0.5x. No pipeline = 0."),
    ("GRW-POS","GRW","Market Positioning",0.20,"select_map","GRW-POSITIONING",
     {"map":{"strong_defined":100,"moderate":45,"undifferentiated_unclear":10}},
     "Top band raised to 100 (DRS-2.0) for consistency with every other select_map."),
    ("GRW-REPEAT","GRW","Product/Service Repeatability",0.15,"band_gte","GRW-REPEAT-PCT",
     {"bands":[[70,100],[50,65],[30,30],[0,0]]},""),
    # Owner Readiness Index (not in DRS) - v1 conventions, Matthew to ratify
    ("ORI-DEPEND","PFN","Lifestyle Price Dependence",0.25,"scale_map","PFN-DEPEND",{"formula":"(v-1)*25"},"v1 convention"),
    ("ORI-OUTSIDE","PFN","Outside Assets Sufficiency",0.25,"select_map","PFN-OUTSIDE",
     {"map":{"yes":100,"mostly":75,"partially":40,"no":0}},"v1 convention"),
    ("ORI-DEBT","PFN","Personal Obligations Alignment",0.10,"select_map","PFN-DEBT",
     {"map":{"yes":100,"minor_issues":60,"significant_issues":20}},"v1 convention"),
    ("ORI-LASTVAL","VAL","Valuation Currency",0.15,"select_map","VAL-LASTVAL",
     {"map":{"within_12mo":100,"one_3yr":70,"over_3yr":30,"never":0},"na_when":{"business_age_lt":3}},
     "v1 convention. N/A below 3 years in business: too young to be expected to hold a current professional valuation."),
    ("ORI-CONF","VAL","Value-Goal Confidence",0.15,"scale_map","VAL-CONF",{"formula":"(v-1)*25"},"v1 convention"),
    ("ORI-SEP","VAL","Personal/Business Separation",0.10,"select_map","VAL-SEP",
     {"map":{"fully":100,"mostly":60,"mixed":20}},"v1 convention"),
]

# ---------------- GAP DEFINITIONS ----------------
# code, name, severity, trigger(json), dimension, buyer_question_content, playbook
gaps = [
    ("CUST_CONC","Customer Concentration","critical",{"type":"sub_score_below","code":"CUS-TOP1","threshold":70},"CUS","CM-BUYERQ-CONC","PB-CUST-DIVERSIFY"),
    ("CUST_BASE_CONC","Top-5 Customer Concentration","high",{"type":"sub_score_below","code":"CUS-TOP5","threshold":70},"CUS","CM-BUYERQ-CONC","PB-CUST-DIVERSIFY"),
    ("RECURRING_LOW","Weak Recurring Revenue Base","high",{"type":"sub_score_below","code":"REV-RECUR","threshold":70},"REV","CM-BUYERQ-RECURRING","PB-RECURRING-CONVERT"),
    ("CONTRACT_GAP","Weak Contract Coverage","high",{"type":"sub_score_below","code":"REV-DURABILITY","threshold":70},"REV","CM-BUYERQ-CONTRACTS","PB-RECURRING-CONVERT"),
    ("REV_VOLATILITY","Weak Revenue Growth","med",{"type":"sub_score_below","code":"REV-GROWTH","threshold":50},"REV","CM-BUYERQ-REVDECLINE","PB-REV-STABILITY"),
    ("CHURN_HIGH","Customer Retention Weakness","med",{"type":"sub_score_below","code":"REV-NRR","threshold":70},"REV","CM-BUYERQ-RECURRING","PB-RETENTION-NRR"),
    ("RECON_GAP","Reconciliation Discipline Gap","high",{"type":"sub_score_below","code":"FIN-RECON","threshold":70},"FIN","CM-BUYERQ-ADDBACKS","PB-CLEAN-BOOKS"),
    ("ADDBACK_RISK","Addback Defensibility Risk","critical",{"type":"sub_score_below","code":"FIN-ADDBACK","threshold":70},"FIN","CM-BUYERQ-ADDBACKS","PB-ADDBACK-DOC"),
    ("CASH_BASIS","GAAP Proximity Gap","med",{"type":"sub_score_below","code":"FIN-GAAP","threshold":70},"FIN","CM-BUYERQ-ADDBACKS","PB-CLEAN-BOOKS"),
    ("STMT_INCOMPLETE","Incomplete Financial Statements","med",{"type":"sub_score_below","code":"FIN-STATEMENTS","threshold":70},"FIN","CM-BUYERQ-ADDBACKS","PB-CLEAN-BOOKS"),
    ("OWNER_DEP","Owner Dependence","critical",{"type":"sub_score_below","code":"OPS-HOURS","threshold":50},"OPS","CM-BUYERQ-OWNER","PB-OWNER-EXTRACT"),
    ("SOP_GAP","Undocumented Core Processes","high",{"type":"sub_score_below","code":"OPS-SOP","threshold":70},"OPS","CM-BUYERQ-SOPS","PB-SOP-LIBRARY"),
    ("MGMT_DEPTH","Insufficient Management Depth","high",{"type":"sub_score_below","code":"OPS-DEPTH","threshold":70},"OPS","CM-BUYERQ-OWNER","PB-MGMT-DEPTH"),
    ("AUTOMATION_LOW","Manual Operations Dependency","low",{"type":"sub_score_below","code":"OPS-AUTO","threshold":70},"OPS","CM-BUYERQ-SOPS","PB-SOP-LIBRARY"),
    ("MGMT_LAYER_GAP","No Functional Management Layer","high",{"type":"sub_score_below","code":"MGT-LAYERS","threshold":65},"MGT","CM-BUYERQ-OWNER","PB-MGMT-DEPTH"),
    ("NONCOMPETE_GAP","Key Person Non-Compete Gap","high",{"type":"sub_score_below","code":"MGT-NC","threshold":70},"MGT","CM-BUYERQ-NONCOMPETE","PB-NONCOMPETES"),
    ("COMP_RISK","Compensation Flight Risk","med",{"type":"sub_score_below","code":"MGT-COMP","threshold":70},"MGT","CM-BUYERQ-NONCOMPETE","PB-COMP-BENCHMARK"),
    ("TURNOVER_HIGH","Retention History Weakness","med",{"type":"sub_score_below","code":"MGT-RETENTION","threshold":70},"MGT","CM-BUYERQ-NONCOMPETE","PB-COMP-BENCHMARK"),
    ("PIPELINE_BLIND","No Pipeline Discipline","med",{"type":"all","conditions":[{"type":"sub_score_below","code":"GRW-PIPE","threshold":70},{"type":"answer_not_in","question_code":"REV-MODEL","values":["recurring","asset_rental"]}]},"GRW","CM-BUYERQ-RECURRING","PB-GROWTH-ENGINE"),
    ("POSITIONING_WEAK","Undifferentiated Market Position","med",{"type":"sub_score_below","code":"GRW-POS","threshold":45},"GRW","CM-EDU-DRS-101","PB-GROWTH-ENGINE"),
    ("CUSTOM_HEAVY","Custom-Work Revenue Dependency","med",{"type":"sub_score_below","code":"GRW-REPEAT","threshold":65},"GRW","CM-BUYERQ-RECURRING","PB-GROWTH-ENGINE"),
    ("VALUE_GAP","Personal Value Gap","critical",{"type":"all","conditions":[{"type":"answer_in","question_code":"PFN-OUTSIDE","values":["partially","no"]},{"type":"answer_lte","question_code":"VAL-CONF","value":2}]},"PFN","CM-EDU-VALUE-GAP","PB-VALUE-GAP-PLAN"),
    ("TIMELINE_MISMATCH","Exit Timeline vs Readiness Mismatch","high",{"type":"all","conditions":[{"type":"answer_in","question_code":"GOL-TIMELINE","values":["under_12mo"]},{"type":"composite_below","score_group":"business_readiness","threshold":70}]},"GOL","CM-EDU-EXIT-TIMELINE","PB-VALUE-GAP-PLAN"),
    ("STALE_VALUATION","No Current Valuation","low",{"type":"all","conditions":[{"type":"answer_in","question_code":"VAL-LASTVAL","values":["over_3yr","never"]},{"type":"business_age_gte","years":3}]},"VAL","CM-EDU-VALUE-GAP","PB-VALUE-GAP-PLAN"),
]

# ---------------- CONTENT MODULES (A13 buyer question prep + education) ----------------
content = [
    ("CM-BUYERQ-CONC","Buyer Question Prep: Customer Concentration","REV",
     "BUYER QUESTION: What happens to your revenue if this client does not renew or transitions their business?\n\nRESPONSE FRAMEWORK: Address contract term remaining, relationship longevity (tenure), specific retention initiatives underway, and the alternative customer pipeline that offsets concentration risk.\n\nDOCUMENTATION NEEDED: Signed contract with remaining term. Evidence of relationship longevity. Customer diversification pipeline metrics."),
    ("CM-BUYERQ-OWNER","Buyer Question Prep: Owner Dependence","OPS",
     "BUYER QUESTION: Can this business operate without you at current performance levels?\n\nRESPONSE FRAMEWORK: Describe the existing management team's functional coverage, in-progress SOP documentation, transition plan timeline, and any period of parallel operation before close.\n\nDOCUMENTATION NEEDED: Org chart. SOP documentation index. Management team bios. Transition plan."),
    ("CM-BUYERQ-RECURRING","Buyer Question Prep: Forward Revenue Visibility","REV",
     "BUYER QUESTION: What is the visibility into your forward revenue beyond the current backlog?\n\nRESPONSE FRAMEWORK: Articulate pipeline conversion rate, average sales cycle, contract renewal rate for project-based clients who re-engage, and any subscription/retainer conversion initiatives.\n\nDOCUMENTATION NEEDED: Pipeline data. Historical win rate. Customer re-engagement history."),
    ("CM-BUYERQ-ADDBACKS","Buyer Question Prep: Addback Substantiation","FIN",
     "BUYER QUESTION: Can you substantiate the addbacks included in your EBITDA recast?\n\nRESPONSE FRAMEWORK: Have documentation ready for every addback: invoices, receipts, W2s, third-party comp benchmarks, and a narrative explanation for each item. Do not let this be a diligence surprise.\n\nDOCUMENTATION NEEDED: Itemized addback schedule. Supporting documentation per line item. Third-party comp benchmark for owner compensation."),
    ("CM-BUYERQ-SOPS","Buyer Question Prep: Process Documentation","OPS",
     "BUYER QUESTION: How are your core operational processes managed and documented?\n\nRESPONSE FRAMEWORK: Describe the current state of documentation, active documentation projects, and which processes have already been successfully delegated to team members.\n\nDOCUMENTATION NEEDED: SOP library (even partial). Evidence of successful delegation in prior periods."),
    ("CM-BUYERQ-NONCOMPETE","Buyer Question Prep: Key Employee Retention","MGT",
     "BUYER QUESTION: What retains your key employees post-close?\n\nRESPONSE FRAMEWORK: Describe current compensation relative to market, any equity or retention programs, and relationship-based retention factors. Acknowledge gaps and present a timeline for non-compete execution.\n\nDOCUMENTATION NEEDED: Employment agreements. Comp benchmarking. Any retention bonus plans."),
    ("CM-BUYERQ-REVDECLINE","Buyer Question Prep: Revenue Decline Narrative","REV",
     "BUYER QUESTION: Walk us through the revenue decline in [year]. What caused it and what changed?\n\nRESPONSE FRAMEWORK: Prepare a specific narrative: external factors (macro, client-specific), internal response, and evidence the root cause is resolved. Do not generalize. Buyers hear generalization as evasion.\n\nDOCUMENTATION NEEDED: Year-over-year revenue by customer. Evidence of corrective action. Current period data showing recovery."),
    ("CM-BUYERQ-CONTRACTS","Buyer Question Prep: Informal Recurring Revenue","REV",
     "BUYER QUESTION: Your recurring revenue appears to be informal. What governs these relationships?\n\nRESPONSE FRAMEWORK: Acknowledge, and describe the upgrade plan: in-progress contracting effort, letter of intent or renewal discussions underway, and historical evidence that these relationships are sticky despite informal structure.\n\nDOCUMENTATION NEEDED: Any written communication confirming ongoing relationship. Timeline for formal contract execution."),
    ("CM-EDU-DRS-101","Understanding Your Diligence Readiness Score","GOL",
     "Explains the six DRS categories, what buyers look for in each, the tier system (Institutional Grade 85+, Sale Ready 70-84, Needs Work 55-69, High Risk 40-54, Not Saleable Yet below 40), and how the score maps to buyer behavior and valuation multiples."),
    ("CM-EDU-EBITDA-RECAST","EBITDA Recast: The Number Buyers Actually Pay For","FIN",
     "Explains reported vs defensible EBITDA, the addback schedule, challenge likelihood ratings (LOW/MEDIUM/HIGH/NOT DEFENSIBLE), and why documentation converts aggressive addbacks into bankable value."),
    ("CM-EDU-VALUE-GAP","The Value Gap: What Your Business Is Worth vs What It Could Be","VAL",
     "Explains current EV vs target EV, how each resolved risk expands the multiple, and the cost of inaction: what the business loses in value per year of delay."),
    ("CM-EDU-EXIT-TIMELINE","Sequencing Your Exit: Why Timing Follows Readiness","GOL",
     "Explains the three-phase roadmap (0-6mo risk elimination, 6-18mo structural improvement, 18-36mo value optimization), DRS milestones (Diligence Ready at 70, Competitive Process Ready at 85), and why going to market early costs real dollars."),
]

# ---------------- PLAYBOOKS ----------------
# code, name, dimension, phase, ev_impact, summary, tasks[(title, role, offset_days)]
playbooks = [
    ("PB-CLEAN-BOOKS","Clean Books Program","FIN","Phase 1 (0-6mo)",
     "EBITDA quality improvement; reduces retrade risk; Financial Integrity score uplift.",
     "Bring financial records to buyer-underwritable quality: monthly reconciliation, accrual bridge, complete statements.",
     [("Engage outside CPA; define path to reviewed statements","owner",14),
      ("Implement monthly bank reconciliation discipline","cpa",30),
      ("Build cash-to-accrual bridge or convert to accrual basis","cpa",60),
      ("Produce full three-statement package (P&L, BS, Cash Flow) and reconcile","cpa",90),
      ("Assemble 36-month financial history package","advisor",120)]),
    ("PB-ADDBACK-DOC","Addback Documentation Program","FIN","Phase 1 (0-6mo)",
     "Shifts HIGH CHALLENGE addbacks to LOW CHALLENGE; Financial Integrity +15 pts typical; reduced retrade risk.",
     "Document every EBITDA addback so it survives a quality-of-earnings review.",
     [("Build itemized addback schedule with dollar amounts","advisor",14),
      ("Collect receipts/invoices/W2s per addback line item","owner",45),
      ("Obtain third-party market comp benchmark for owner role","advisor",45),
      ("Rate each addback for challenge likelihood; remediate or remove HIGH items","advisor",75),
      ("Document related-party transactions with market-rate comparisons","cpa",90)]),
    ("PB-CUST-DIVERSIFY","Customer Diversification Program","CUS","Phase 2 (6-18mo)",
     "EBITDA x 0.50 multiple expansion typical (DRS +15-20 pts if top customer currently >35%).",
     "Reduce top-customer exposure below 25% and strengthen contractual protection on Tier 1 accounts.",
     [("Build concentration heatmap; identify Tier 1 (>10%) accounts","advisor",14),
      ("Secure multi-year renewals on Tier 1 accounts; remove change-of-control clauses where possible","owner",90),
      ("Launch targeted acquisition plan for accounts in underweighted segments","owner",120),
      ("Institutionalize Tier 1 relationships: second point of contact, account team","ops",150),
      ("Track top-1 and top-5 share monthly against reduction targets","advisor",180)]),
    ("PB-RECURRING-CONVERT","Recurring Revenue Conversion","REV","Phase 2 (6-18mo)",
     "EBITDA increase plus 0.25-0.50x multiple expansion; each $100K converted compounds.",
     "Convert transactional and informal revenue to contracted retainer/subscription structures.",
     [("Segment revenue: contracted recurring vs informal recurring vs project","advisor",21),
      ("Design retainer/subscription offers for convertible segments","owner",60),
      ("Paper all informal recurring relationships with formal agreements","owner",120),
      ("Standardize renewal terms; target 18+ month average remaining term","advisor",150),
      ("Report recurring % and contract coverage quarterly","advisor",180)]),
    ("PB-RETENTION-NRR","Retention and NRR Program","REV","Phase 2 (6-18mo)",
     "NRR sub-score uplift; supports Revenue Quality and buyer confidence in forward revenue.",
     "Instrument churn and NRR, then fix the leaks.",
     [("Implement cohort revenue tracking to compute NRR annually","ops",30),
      ("Run churn post-mortems on last 3 years of lost customers","advisor",60),
      ("Launch retention initiatives on at-risk segments","owner",120)]),
    ("PB-SOP-LIBRARY","SOP Documentation Program","OPS","Phase 1 (0-6mo)",
     "EBITDA x 0.25 multiple expansion typical (DRS +10-15 pts); prerequisite for delegation.",
     "Document core processes: sales, delivery, onboarding, invoicing/collections, key vendor management.",
     [("Inventory core processes and rank by owner-dependency","advisor",14),
      ("Document top 3 highest-dependency processes first","ops",60),
      ("Complete SOP library to 80% coverage","ops",150),
      ("Automate top repetitive tasks (invoicing, reporting, scheduling)","ops",180),
      ("Validate SOPs by having a non-owner execute each process","ops",180)]),
    ("PB-OWNER-EXTRACT","Owner Extraction Program","OPS","Phase 2 (6-18mo)",
     "EBITDA x 0.25-0.75 multiple expansion depending on revenue concentration in owner-held relationships (DRS +10-20 pts).",
     "Reduce owner hours in operations below 10/week and transition owner-held relationships to the team.",
     [("Time-audit owner week; classify operations vs strategy vs external","advisor",14),
      ("Delegate documented processes to named managers (requires PB-SOP-LIBRARY)","owner",90),
      ("Transition owner-held customer relationships to account management","owner",180),
      ("Introduce second point of contact for every >5% revenue customer","ops",210),
      ("Run a 2-week owner-absence test and document results","advisor",270)]),
    ("PB-MGMT-DEPTH","Management Depth Program","MGT","Phase 3 (18-36mo)",
     "Management sub-score uplift; supports Operational Independence; DRS +5-10 pts typical.",
     "Build at least one qualified manager per core function with defined authority.",
     [("Map core functions to current qualified coverage","advisor",21),
      ("Define hiring/promotion plan for uncovered functions","owner",60),
      ("Delegate decision authority with documented thresholds","owner",120),
      ("Implement management reporting rhythm (weekly ops, monthly financial)","ops",150)]),
    ("PB-NONCOMPETES","Key Employee Agreement Program","MGT","Phase 1 (0-6mo)",
     "EBITDA x 0.10-0.20 multiple expansion (DRS +5-8 pts if currently <50% coverage).",
     "Obtain signed non-compete/non-solicit agreements from all key employees.",
     [("Identify key employees (revenue-generating, function-critical)","advisor",14),
      ("Engage employment counsel; confirm state enforceability posture","owner",30),
      ("Roll out agreements, paired with retention incentives where needed","owner",75),
      ("Track coverage to 100% of key employees","advisor",90)]),
    ("PB-COMP-BENCHMARK","Compensation and Retention Program","MGT","Phase 3 (18-36mo)",
     "Removes flight-risk discount; Management score uplift.",
     "Benchmark key-role compensation to market and fix retention risk.",
     [("Obtain third-party comp benchmarks for key roles","advisor",30),
      ("Adjust below-market roles into +/-15% band or add retention plans","owner",90),
      ("Establish turnover tracking and stay-interview cadence","ops",120)]),
    ("PB-REV-STABILITY","Revenue Stability Narrative","REV","Phase 1 (0-6mo)",
     "Prevents diligence surprise; converts volatility from unexplained risk to explained event.",
     "Build the decline-year narrative with evidence of resolution.",
     [("Reconstruct year-over-year revenue by customer for decline years","advisor",30),
      ("Document root cause, corrective action, and recovery evidence","owner",60),
      ("Fold narrative into buyer question prep guide","advisor",75)]),
    ("PB-GROWTH-ENGINE","Growth Engine Program","GRW","Phase 3 (18-36mo)",
     "Growth score uplift; supports premium-multiple growth story.",
     "Build pipeline discipline, positioning clarity, and offer repeatability.",
     [("Implement CRM pipeline with stages, values, close dates","ops",45),
      ("Define ICP and differentiation; standardize the sales motion","owner",90),
      ("Productize custom work into standardized offerings where possible","owner",180),
      ("Report pipeline coverage ratio monthly; target 3x annual revenue","advisor",210)]),
    ("PB-VALUE-GAP-PLAN","Owner Value Gap Plan","PFN","Phase 1 (0-6mo)",
     "Aligns engagement targets to the owner's actual financial need; anchors the cost-of-inaction conversation.",
     "Quantify the gap between what the owner needs and what the business supports, then set targets.",
     [("Obtain current professional valuation or calculation of value","advisor",45),
      ("Coordinate with owner's personal financial advisor on wealth gap analysis","owner",60),
      ("Set target DRS and target EV against the owner's number and timeline","advisor",75),
      ("Review roadmap and value gap with owner quarterly","advisor",90)]),
]

# ---------------- REFERENCE SCORER ----------------
def band_gte(v, bands, unknown=None):
    if v is None: return unknown
    for th, pts in bands:
        if v >= th: return pts
    return bands[-1][1]

def band_lt(v, bands_lt, else_pts):
    for th, pts in bands_lt:
        if v < th: return pts
    return else_pts

def validate(ans):
    """Reject inputs whose domain the arithmetic depends on, before any math
    runs. Mirrors validateAnswers() in shared/scoring/engine.ts so the reference
    and the engine agree on invalid inputs too. Only affects malformed
    assessments; well-formed fixtures are unchanged (CLAUDE.md rule 1)."""
    annual = ans["REV-ANNUAL"]
    if not isinstance(annual, list) or len(annual) < 2:
        raise ValueError("REV-ANNUAL: at least two fiscal years of revenue are required to score growth")
    if any((not isinstance(x, (int, float))) or x <= 0 for x in annual):
        raise ValueError("REV-ANNUAL: revenue for each fiscal year must be greater than 0")
    top5 = ans["REV-TOP5-SHARES"]
    if not isinstance(top5, list) or len(top5) < 1:
        raise ValueError("REV-TOP5-SHARES: at least one customer share is required")
    if len(top5) > 5:
        raise ValueError("REV-TOP5-SHARES: expected at most five customer shares")
    if any(x < 0 or x > 100 for x in top5):
        raise ValueError("REV-TOP5-SHARES: each customer share must be a percentage between 0 and 100")
    if sum(top5) > 100.5:
        raise ValueError("REV-TOP5-SHARES: customer shares sum to more than 100%")
    if ans["OPS-FUNC-COUNT"] < 1:
        raise ValueError("OPS-FUNC-COUNT: core function count must be at least 1 to score management depth")
    ec = ans.get("EMPLOYEE-COUNT")
    if ec is not None and ans["OPS-MGR-COUNT"] > ec:
        raise ValueError("OPS-MGR-COUNT: qualified managers cannot exceed EMPLOYEE-COUNT (non-owner employees)")
    for code in ("PFN-DEPEND", "VAL-CONF"):
        if not (1 <= ans[code] <= 5):
            raise ValueError(f"{code}: must be on the 1-5 scale")

def score_company(ans):
    validate(ans)
    ss = {}
    flags = []
    top5 = ans["REV-TOP5-SHARES"]; top1 = top5[0]; top5sum = sum(top5)
    annual = ans["REV-ANNUAL"]
    n = len(annual)
    cagr = (annual[-1]/annual[0])**(1/(n-1)) - 1
    down = sum(1 for i in range(1,n) if annual[i] < annual[i-1])
    # REV
    ss["REV-RECUR"] = band_gte(ans["REV-RECUR-PCT"], [(80,100),(60,75),(40,50),(20,25),(0,0)])
    hhi = sum(s*s for s in top5)
    h = band_lt(hhi, [(1000,100),(1500,80),(2000,55),(2500,30),(4000,15),(6000,7)], 0)
    if top1 > 30: h = min(h, 60)
    ss["REV-HHI"] = h
    ss["REV-DURABILITY"] = round(100*min(1,ans["REV-CONTRACT-CUST-PCT"]/75)*min(1,ans["REV-CONTRACT-AVG-MO"]/18),2)
    c = cagr*100
    # DRS-2.0: a mild overall decline that is otherwise steady earns partial credit
    # instead of the old hard zero, so a soft decliner is not double-penalized here
    # and in GRW-CAGR at once.
    if c >= 15 and down == 0: g = 100
    elif c >= 10 and down <= 1: g = 75
    elif c >= 5 and down <= 1: g = 50
    elif c >= 0: g = 25
    elif c >= -5 and down <= 1: g = 15
    else: g = 0
    ss["REV-GROWTH"] = g
    nrr = ans["REV-NRR"]
    if nrr == "unknown":
        ss["REV-NRR"] = 25; flags.append("NRR not tracked")
    else:
        ss["REV-NRR"] = band_gte(nrr, [(110,100),(100,80),(90,50),(80,25),(0,0)])
    # FIN
    ss["FIN-RECON"] = {"monthly":100,"quarterly":65,"annual":30,"none":0}[ans["FIN-RECON"]]
    ss["FIN-ADDBACK"] = {"fully_documented":100,"mostly_documented":70,"partially_documented":40,"undocumented":10}[ans["FIN-ADDBACK-DOC"]]
    ss["FIN-GAAP"] = {"accrual_consistent":100,"cash_with_bridge":60,"cash_mixed":25,"unreconcilable":0}[ans["FIN-BASIS"]]
    ss["FIN-STATEMENTS"] = {"all_three":100,"pl_and_bs":65,"pl_only":30,"spreadsheet_only":10}[ans["FIN-STATEMENTS"]]
    # OPS
    ss["OPS-HOURS"] = band_lt(ans["OPS-OWNER-HOURS"], [(10,100),(20,75),(30,45),(40,20)], 0)
    ss["OPS-SOP"] = band_gte(ans["OPS-SOP-PCT"], [(80,100),(60,70),(40,40),(20,15),(0,0)])
    r = ans["OPS-MGR-COUNT"]/ans["OPS-FUNC-COUNT"]
    ss["OPS-DEPTH"] = 100 if r >= 1 else 75 if r >= 0.75 else 40 if r >= 0.5 else 10
    ss["OPS-AUTO"] = band_gte(ans["OPS-AUTO-PCT"], [(70,100),(50,70),(30,40),(0,15)])
    # CUS
    t1 = band_lt(top1, [(10,100),(20,75),(30,45),(40,25),(50,15),(65,7)], 0)
    # anchor offset: a contractually locked-in dominant customer (no change-of-control
    # clause, >=24mo avg remaining term) is a different risk than a fragile whale.
    if top1 >= 40 and ans.get("CUS-COC-CTX") == "none" and ans.get("REV-CONTRACT-AVG-MO", 0) >= 24:
        t1 = max(t1, 45)
    ss["CUS-TOP1"] = t1
    ss["CUS-TOP5"] = band_lt(top5sum, [(30,100),(45,75),(60,45),(75,25),(90,12)], 0)
    ss["CUS-TENURE"] = band_gte(ans["CUS-TENURE"], [(5,100),(3,75),(2,50),(1,25),(0,0)])
    ss["CUS-COVERAGE"] = band_gte(ans["CUS-REV-CONTRACT-PCT"], [(80,100),(60,70),(40,40),(0,10)])
    ss["CUS-CHURN"] = band_lt(ans["CUS-CHURN"], [(5,100),(10,70),(15,40),(20,15)], 0)
    # MGT
    ss["MGT-LAYERS"] = {"two_plus_layers":100,"one_clear_layer":65,"informal_partial":30,"none_all_report_to_owner":0}[ans["MGT-LAYERS"]]
    ss["MGT-NC"] = band_gte(ans["MGT-NC-PCT"], [(100,100),(75,70),(50,35),(0,0)])
    ss["MGT-COMP"] = {"within_15pct":100,"below_15_25pct":50,"below_25pct_plus":0,"above_25pct_plus":70}[ans["MGT-COMP"]]
    ss["MGT-RETENTION"] = band_lt(ans["MGT-TURNOVER"], [(10,100),(15,70),(25,35)], 0)
    # GRW — DRS-2.0: graded negative bands (soft/eroding/melting) instead of a
    # single hard zero for all decline.
    if c >= 20: gc = 100
    elif c >= 15: gc = 85
    elif c >= 10: gc = 65
    elif c >= 5: gc = 40
    elif c >= 0: gc = 20
    elif c >= -5: gc = 15
    elif c >= -15: gc = 5
    else: gc = 0
    ss["GRW-CAGR"] = gc
    # DRS-2.0: coverage is measured against the AVERAGE of the provided years, not
    # the latest one, so a revenue collapse can no longer mechanically inflate it.
    avg_rev = sum(annual)/len(annual)
    pipe = ans["GRW-PIPELINE"]/avg_rev if ans["GRW-PIPELINE"] > 0 and avg_rev > 0 else 0
    ss["GRW-PIPE"] = 0 if ans["GRW-PIPELINE"] <= 0 else band_gte(pipe, [(3,100),(2,70),(1,35),(0.5,15),(0,0)])
    ss["GRW-POS"] = {"strong_defined":100,"moderate":45,"undifferentiated_unclear":10}[ans["GRW-POSITIONING"]]
    ss["GRW-REPEAT"] = band_gte(ans["GRW-REPEAT-PCT"], [(70,100),(50,65),(30,30),(0,0)])
    # applicability (na_when) — a sub-score can be Not Applicable for this
    # assessment (insufficient operating history, or inapplicable to the revenue
    # model). N/A sub-scores are excluded from their dimension, which re-normalizes
    # over the remaining weights. Points are still computed (for the explain trace)
    # but not counted.
    biz_age = ans.get("BIZ-AGE-YEARS")
    ec = ans.get("EMPLOYEE-COUNT")
    def applicable(logic):
        na = logic.get("na_when")
        if not na: return True
        if "business_age_lt" in na and biz_age is not None and biz_age < na["business_age_lt"]:
            return False
        if "history_years_lt" in na and n < na["history_years_lt"]:
            return False
        if "employee_count_lte" in na:
            ec = ans.get("EMPLOYEE-COUNT")
            if ec is not None and ec <= na["employee_count_lte"]:
                return False
        if "answer_unknown" in na and ans.get(na["answer_unknown"]) == "unknown":
            return False
        if "answer_in" in na:
            cond = na["answer_in"]
            if ans.get(cond["question_code"]) in cond["values"]:
                return False
        return True
    applic = {s[0]: applicable(s[6]) for s in subscores}
    # dimensions — re-normalize ONLY when a sub-score is N/A. The all-applicable
    # branch is the exact weighted sum, so unchanged assessments reproduce
    # bit-for-bit (weights are validated to sum to 1.0 per dimension).
    dims = {}
    for dcode in ["REV","FIN","OPS","CUS","MGT","GRW"]:
        all_parts = [s for s in subscores if s[1] == dcode]
        parts = [(s[3], ss[s[0]]) for s in all_parts if applic[s[0]]]
        if len(parts) == len(all_parts):
            dims[dcode] = round(sum(w*v for w,v in parts), 2)
        else:
            wsum = sum(w for w,_ in parts)
            dims[dcode] = round(sum(w*v for w,v in parts)/wsum, 2) if wsum > 0 else 0
    weights = {"REV":0.25,"FIN":0.20,"OPS":0.20,"CUS":0.15,"MGT":0.10,"GRW":0.10}
    drs = round(sum(dims[d]*w for d,w in weights.items()), 1)
    # Concentration governor (D2): an unprotected dominant single customer (>=50%
    # of revenue, no long-term change-of-control-proof contract) is not
    # institutionally saleable regardless of how clean the rest is. Concentration
    # otherwise reaches only ~14.5% of the DRS, so the bands alone cannot hold such
    # a business below Sale Ready; cap it at the top of Needs Work.
    anchor_protected = top1 >= 40 and ans.get("CUS-COC-CTX") == "none" and ans.get("REV-CONTRACT-AVG-MO", 0) >= 24
    if top1 >= 50 and not anchor_protected:
        drs = min(drs, 69.0)
    tier = ("Institutional Grade" if drs>=85 else "Sale Ready" if drs>=70 else
            "Needs Work" if drs>=55 else "High Risk" if drs>=40 else "Not Saleable (Yet)")
    # Owner Readiness Index (owner_readiness group; never enters the DRS). Same
    # exact-path-unless-N/A rule as the business dimensions.
    ori_parts = [
        (0.25,(ans["PFN-DEPEND"]-1)*25),
        (0.25,{"yes":100,"mostly":75,"partially":40,"no":0}[ans["PFN-OUTSIDE"]]),
        (0.10,{"yes":100,"minor_issues":60,"significant_issues":20}[ans["PFN-DEBT"]]),
    ]
    if applic["ORI-LASTVAL"]:
        ori_parts.append((0.15,{"within_12mo":100,"one_3yr":70,"over_3yr":30,"never":0}[ans["VAL-LASTVAL"]]))
    ori_parts += [
        (0.15,(ans["VAL-CONF"]-1)*25),
        (0.10,{"fully":100,"mostly":60,"mixed":20}[ans["VAL-SEP"]]),
    ]
    if applic["ORI-LASTVAL"]:
        ori = round(sum(w*v for w,v in ori_parts), 1)
    else:
        owsum = sum(w for w,_ in ori_parts)
        ori = round(sum(w*v for w,v in ori_parts)/owsum, 1)
    # gaps
    triggered = []
    for gcode, name, sev, trig, dim, cm, pb in gaps:
        t = trig
        def ev(t):
            # a gap keyed on an N/A sub-score cannot fire (the metric doesn't apply)
            if t["type"] == "sub_score_below": return applic.get(t["code"], True) and ss[t["code"]] < t["threshold"]
            if t["type"] == "answer_in": return ans.get(t["question_code"]) in t["values"]
            if t["type"] == "answer_not_in": return ans.get(t["question_code"]) not in t["values"]
            if t["type"] == "answer_lte": return ans.get(t["question_code"]) <= t["value"]
            if t["type"] == "composite_below": return drs < t["threshold"]
            if t["type"] == "business_age_gte": return biz_age is None or biz_age >= t["years"]
            if t["type"] == "all": return all(ev(c) for c in t["conditions"])
            return False
        if ev(t): triggered.append(gcode)
    # Blind-spot flags (D6): the DRS is a STANDALONE OPERATIONAL readiness index and
    # cannot see license/CON transferability or asset/IP value. When a value-defining
    # factor sits outside the model, flag it so a high score is never read as "no
    # risks" on a business whose value lives where the DRS cannot look.
    if ans.get("OPS-LICENSE-DEP") in ("requires_requalification", "may_not_transfer"):
        flags.append("Value depends on a license, CON, or franchise that may not transfer to a buyer; the DRS scores standalone operational readiness only")
    if ans.get("VAL-ASSETS-CTX") in ("real_estate", "ip", "equipment", "other"):
        flags.append("Material tangible assets or IP the DRS does not value; obtain a separate asset/IP appraisal")
    if ec is not None and ec <= 3:
        flags.append("Owner-operated business: value is on a seller's-discretionary-earnings / book-of-business basis with an owner transition or earnout; the DRS reflects operational transferability, which is inherently limited for a very small team")
    return {"sub_scores": ss, "dimension_scores": dims, "drs": drs, "tier": tier,
            "owner_readiness_index": ori, "gaps": sorted(triggered), "flags": flags,
            "not_applicable": sorted(c for c,ok in applic.items() if not ok),
            "computed": {"hhi_est": hhi, "top1_pct": top1, "top5_pct": top5sum,
                         "cagr_pct": round(c,2), "down_years": down,
                         "pipeline_coverage": round(pipe,2)}}

# ---------------- FIXTURE COMPANIES ----------------
fixtures = {
 "company-1-meridian-managed-it": {
  "profile": "Managed IT services, $4.6M revenue, strong contracts, modest owner involvement. Expected tier: Sale Ready.",
  "answers": {
    "REV-RECUR-PCT":72,"REV-TOP5-SHARES":[12,9,7,5,4],"REV-CONTRACT-CUST-PCT":80,"REV-CONTRACT-AVG-MO":20,
    "REV-ANNUAL":[3100000,3500000,4000000,4600000],"REV-NRR":108,
    "FIN-RECON":"monthly","FIN-ADDBACK-DOC":"mostly_documented","FIN-BASIS":"accrual_consistent","FIN-STATEMENTS":"all_three",
    "OPS-OWNER-HOURS":12,"OPS-SOP-PCT":65,"OPS-MGR-COUNT":3,"OPS-FUNC-COUNT":4,"OPS-AUTO-PCT":55,
    "CUS-TENURE":6,"CUS-REV-CONTRACT-PCT":82,"CUS-CHURN":6,
    "MGT-LAYERS":"one_clear_layer","MGT-NC-PCT":80,"MGT-COMP":"within_15pct","MGT-TURNOVER":8,
    "GRW-PIPELINE":9200000,"GRW-POSITIONING":"strong_defined","GRW-REPEAT-PCT":75,
    "GOL-TIMELINE":"two_3yr","PFN-DEPEND":4,"PFN-OUTSIDE":"mostly","PFN-DEBT":"yes",
    "VAL-LASTVAL":"one_3yr","VAL-CONF":4,"VAL-SEP":"fully"}},
 "company-2-apex-fabrication": {
  "profile": "Custom metal fabrication, $5.1M revenue, one dominant customer, owner-run, weak books. Expected tier: Not Saleable (Yet).",
  "answers": {
    "REV-RECUR-PCT":12,"REV-TOP5-SHARES":[41,18,11,6,4],"REV-CONTRACT-CUST-PCT":25,"REV-CONTRACT-AVG-MO":6,
    "REV-ANNUAL":[5200000,4800000,5000000,5100000],"REV-NRR":"unknown",
    "FIN-RECON":"annual","FIN-ADDBACK-DOC":"undocumented","FIN-BASIS":"cash_mixed","FIN-STATEMENTS":"pl_only",
    "OPS-OWNER-HOURS":50,"OPS-SOP-PCT":15,"OPS-MGR-COUNT":1,"OPS-FUNC-COUNT":4,"OPS-AUTO-PCT":20,
    "CUS-TENURE":8,"CUS-REV-CONTRACT-PCT":30,"CUS-CHURN":4,
    "MGT-LAYERS":"none_all_report_to_owner","MGT-NC-PCT":0,"MGT-COMP":"below_15_25pct","MGT-TURNOVER":12,
    "GRW-PIPELINE":0,"GRW-POSITIONING":"undifferentiated_unclear","GRW-REPEAT-PCT":25,
    "GOL-TIMELINE":"under_12mo","PFN-DEPEND":1,"PFN-OUTSIDE":"no","PFN-DEBT":"significant_issues",
    "VAL-LASTVAL":"never","VAL-CONF":2,"VAL-SEP":"mixed"}},
 "company-3-harborview-staffing": {
  "profile": "Specialty staffing, $7.0M revenue, mid-pack on most dimensions. Expected tier: High Risk (upper end).",
  "answers": {
    "REV-RECUR-PCT":45,"REV-TOP5-SHARES":[22,14,9,6,5],"REV-CONTRACT-CUST-PCT":55,"REV-CONTRACT-AVG-MO":12,
    "REV-ANNUAL":[6000000,6600000,6100000,7000000],"REV-NRR":96,
    "FIN-RECON":"quarterly","FIN-ADDBACK-DOC":"partially_documented","FIN-BASIS":"cash_with_bridge","FIN-STATEMENTS":"pl_and_bs",
    "OPS-OWNER-HOURS":28,"OPS-SOP-PCT":45,"OPS-MGR-COUNT":2,"OPS-FUNC-COUNT":4,"OPS-AUTO-PCT":40,
    "CUS-TENURE":3.5,"CUS-REV-CONTRACT-PCT":58,"CUS-CHURN":11,
    "MGT-LAYERS":"informal_partial","MGT-NC-PCT":60,"MGT-COMP":"within_15pct","MGT-TURNOVER":18,
    "GRW-PIPELINE":8400000,"GRW-POSITIONING":"moderate","GRW-REPEAT-PCT":55,
    "GOL-TIMELINE":"one_2yr","PFN-DEPEND":2,"PFN-OUTSIDE":"partially","PFN-DEBT":"minor_issues",
    "VAL-LASTVAL":"over_3yr","VAL-CONF":3,"VAL-SEP":"mostly"}},
 "company-4-northwind-vertical-saas": {
  "profile": "2-year-old vertical SaaS, $2.6M revenue up from $1.2M, strong ops for its age, owner does not want to sell for 3+ years. Exercises the age-aware N/A mechanic: growth-history (REV-GROWTH, GRW-CAGR), customer tenure (CUS-TENURE), retention history (MGT-RETENTION), and valuation currency (ORI-LASTVAL) are all Not Applicable and re-normalized out, and STALE_VALUATION is suppressed.",
  "answers": {
    "REV-RECUR-PCT":70,"REV-TOP5-SHARES":[14,10,8,6,5],"REV-CONTRACT-CUST-PCT":70,"REV-CONTRACT-AVG-MO":14,
    "REV-ANNUAL":[1200000,2600000],"REV-NRR":115,
    "FIN-RECON":"monthly","FIN-ADDBACK-DOC":"mostly_documented","FIN-BASIS":"accrual_consistent","FIN-STATEMENTS":"all_three",
    "OPS-OWNER-HOURS":30,"OPS-SOP-PCT":45,"OPS-MGR-COUNT":2,"OPS-FUNC-COUNT":4,"OPS-AUTO-PCT":55,
    "CUS-TENURE":1.5,"CUS-REV-CONTRACT-PCT":70,"CUS-CHURN":8,
    "MGT-LAYERS":"one_clear_layer","MGT-NC-PCT":60,"MGT-COMP":"within_15pct","MGT-TURNOVER":10,
    "GRW-PIPELINE":4000000,"GRW-POSITIONING":"strong_defined","GRW-REPEAT-PCT":70,
    "GOL-TIMELINE":"three_plus_yr","PFN-DEPEND":3,"PFN-OUTSIDE":"mostly","PFN-DEBT":"minor_issues",
    "VAL-LASTVAL":"never","VAL-CONF":3,"VAL-SEP":"mostly","BIZ-AGE-YEARS":2}},
 "company-5-cascade-precision-machining": {
  "profile": "18-year-old precision CNC job shop, $10.2M revenue, project/transactional model (no recurring), well-run with clean books and diversified OEM customers. Exercises the revenue-model branch: REV-RECUR, REV-DURABILITY and REV-NRR are Not Applicable (transactional), so Revenue Quality is judged on concentration + growth instead of being capped for lacking subscription revenue.",
  "answers": {
    "REV-RECUR-PCT":10,"REV-TOP5-SHARES":[18,12,9,7,5],"REV-CONTRACT-CUST-PCT":30,"REV-CONTRACT-AVG-MO":4,
    "REV-ANNUAL":[8000000,8800000,9500000,10200000],"REV-NRR":"unknown","REV-MODEL":"transactional_project",
    "FIN-RECON":"monthly","FIN-ADDBACK-DOC":"mostly_documented","FIN-BASIS":"accrual_consistent","FIN-STATEMENTS":"all_three",
    "OPS-OWNER-HOURS":20,"OPS-SOP-PCT":70,"OPS-MGR-COUNT":3,"OPS-FUNC-COUNT":4,"OPS-AUTO-PCT":60,
    "CUS-TENURE":7,"CUS-REV-CONTRACT-PCT":30,"CUS-CHURN":6,
    "MGT-LAYERS":"one_clear_layer","MGT-NC-PCT":70,"MGT-COMP":"within_15pct","MGT-TURNOVER":9,
    "GRW-PIPELINE":6000000,"GRW-POSITIONING":"strong_defined","GRW-REPEAT-PCT":40,
    "GOL-TIMELINE":"two_3yr","PFN-DEPEND":3,"PFN-OUTSIDE":"mostly","PFN-DEBT":"yes",
    "VAL-LASTVAL":"one_3yr","VAL-CONF":4,"VAL-SEP":"fully","BIZ-AGE-YEARS":18}},
 "company-6-summit-aerospace-components": {
  "profile": "22-year-old Tier-1 aerospace components supplier, $21M revenue, one dominant OEM anchor at 55% of revenue but under a 5-year long-term agreement with no change-of-control clause. Exercises the D2 anchor offset: the top-1 concentration sub-score floors at 45 (contractually locked-in anchor) instead of the fragile-whale band, while TOP-5 and HHI still register the real concentration.",
  "answers": {
    "REV-RECUR-PCT":80,"REV-TOP5-SHARES":[55,15,12,10,8],"REV-CONTRACT-CUST-PCT":85,"REV-CONTRACT-AVG-MO":60,
    "REV-ANNUAL":[18000000,19000000,20000000,21000000],"REV-NRR":105,"REV-MODEL":"recurring",
    "CUS-COC-CTX":"none",
    "FIN-RECON":"monthly","FIN-ADDBACK-DOC":"mostly_documented","FIN-BASIS":"accrual_consistent","FIN-STATEMENTS":"all_three",
    "OPS-OWNER-HOURS":15,"OPS-SOP-PCT":70,"OPS-MGR-COUNT":3,"OPS-FUNC-COUNT":4,"OPS-AUTO-PCT":60,
    "CUS-TENURE":12,"CUS-REV-CONTRACT-PCT":85,"CUS-CHURN":3,
    "MGT-LAYERS":"one_clear_layer","MGT-NC-PCT":80,"MGT-COMP":"within_15pct","MGT-TURNOVER":8,
    "GRW-PIPELINE":12000000,"GRW-POSITIONING":"strong_defined","GRW-REPEAT-PCT":70,
    "GOL-TIMELINE":"two_3yr","PFN-DEPEND":4,"PFN-OUTSIDE":"mostly","PFN-DEBT":"yes",
    "VAL-LASTVAL":"one_3yr","VAL-CONF":4,"VAL-SEP":"fully","BIZ-AGE-YEARS":22}},
 "company-7-lakeside-cpa": {
  "profile": "20-year-old solo CPA practice (one admin, owner works full-time), $900K revenue, diversified recurring client base. Exercises the owner-operator branch: the team-structure sub-scores (OPS-DEPTH, MGT-LAYERS, MGT-NC, MGT-RETENTION) are Not Applicable and re-normalized out, so a routinely-sold practice lands in Needs Work with an SDE/transition flag instead of being floored to Not Saleable, and it cannot game a management layer it does not have.",
  "answers": {
    "REV-RECUR-PCT":65,"REV-TOP5-SHARES":[9,7,6,5,4],"REV-CONTRACT-CUST-PCT":40,"REV-CONTRACT-AVG-MO":12,
    "REV-ANNUAL":[720000,780000,840000,900000],"REV-NRR":102,"REV-MODEL":"recurring",
    "FIN-RECON":"monthly","FIN-ADDBACK-DOC":"mostly_documented","FIN-BASIS":"accrual_consistent","FIN-STATEMENTS":"all_three",
    "OPS-OWNER-HOURS":45,"OPS-SOP-PCT":55,"OPS-MGR-COUNT":0,"OPS-FUNC-COUNT":4,"OPS-AUTO-PCT":65,
    "CUS-TENURE":10,"CUS-REV-CONTRACT-PCT":40,"CUS-CHURN":4,
    "MGT-LAYERS":"none_all_report_to_owner","MGT-NC-PCT":0,"MGT-COMP":"within_15pct","MGT-TURNOVER":0,"EMPLOYEE-COUNT":1,
    "GRW-PIPELINE":150000,"GRW-POSITIONING":"moderate","GRW-REPEAT-PCT":75,
    "GOL-TIMELINE":"two_3yr","PFN-DEPEND":3,"PFN-OUTSIDE":"mostly","PFN-DEBT":"yes",
    "VAL-LASTVAL":"one_3yr","VAL-CONF":4,"VAL-SEP":"fully","BIZ-AGE-YEARS":20}},
}

# ---------------- EMIT FILES ----------------
with open(f"{OUT}/drs-rubric-dimensions.csv","w",newline="") as f:
    w = csv.writer(f); w.writerow(["code","name","score_group","drs_weight","sort_order"])
    for row in dimensions: w.writerow(row)

with open(f"{OUT}/drs-rubric-questions.csv","w",newline="") as f:
    w = csv.writer(f); w.writerow(["code","dimension_code","prompt","answer_type","options","scored","sort_order"])
    for row in questions: w.writerow(row)

with open(f"{OUT}/drs-rubric-subscores.csv","w",newline="") as f:
    w = csv.writer(f); w.writerow(["code","dimension_code","name","weight","formula_type","input_question_codes","logic_json","notes"])
    for c,d,n,wt,ft,inp,logic,notes in subscores:
        w.writerow([c,d,n,wt,ft,inp,json.dumps(logic),notes])

with open(f"{OUT}/gap-definitions.csv","w",newline="") as f:
    w = csv.writer(f); w.writerow(["code","name","severity","trigger_json","dimension_code"])
    for gcode,name,sev,trig,dim,cm,pb in gaps: w.writerow([gcode,name,sev,json.dumps(trig),dim])

with open(f"{OUT}/gap-playbook-map.csv","w",newline="") as f:
    w = csv.writer(f); w.writerow(["gap_code","playbook_code","priority"])
    for gcode,name,sev,trig,dim,cm,pb in gaps: w.writerow([gcode,pb,1])

with open(f"{OUT}/gap-content-map.csv","w",newline="") as f:
    w = csv.writer(f); w.writerow(["gap_code","content_code","drip_order"])
    for gcode,name,sev,trig,dim,cm,pb in gaps: w.writerow([gcode,cm,1])

with open(f"{OUT}/content-modules.csv","w",newline="") as f:
    w = csv.writer(f); w.writerow(["code","title","dimension_code","body"])
    for row in content: w.writerow(row)

for code,name,dim,phase,ev,summary,tasks in playbooks:
    lines = [f"---",f"code: {code}",f"name: {name}",f"version: 1",f"dimension: {dim}",
             f"phase: {phase}",f"ev_impact: {ev}",f"summary: {summary}","---","",
             f"# {name}","",f"**Roadmap phase:** {phase}","",f"**Value impact:** {ev}","",
             "## Tasks","","| seq | title | owner_role | offset_days |","|---|---|---|---|"]
    for i,(t,role,off) in enumerate(tasks,1):
        lines.append(f"| {i} | {t} | {role} | {off} |")
    with open(f"{OUT}/playbooks/{code}.md","w") as f: f.write("\n".join(lines)+"\n")

results = {}
for name, fx in fixtures.items():
    res = score_company(fx["answers"])
    results[name] = res
    with open(f"{OUT}/fixtures/{name}.json","w") as f:
        json.dump({"profile": fx["profile"], "answers": fx["answers"], "expected": res}, f, indent=2)

for name, r in results.items():
    print(f"{name}: DRS={r['drs']} ({r['tier']}), ORI={r['owner_readiness_index']}")
    print(f"  dims={r['dimension_scores']}")
    print(f"  gaps={r['gaps']}")
print("\nSeed files written.")
