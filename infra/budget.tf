# Two alerts. On the Free plan, usage is paid from credits first:
#  - "real charges" counts what credits don't cover, i.e. money actually billed;
#  - "credit burn" counts usage before credits, to see how fast credits go.

resource "aws_budgets_budget" "real_charges" {
  name         = "${var.project}-real-charges"
  budget_type  = "COST"
  limit_amount = tostring(var.real_charges_alert_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }
}

resource "aws_budgets_budget" "credit_burn" {
  name         = "${var.project}-credit-burn"
  budget_type  = "COST"
  limit_amount = tostring(var.credit_burn_alert_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_types {
    include_credit = false
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}
