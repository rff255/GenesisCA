#ifndef BREAK_CASE_H
#define BREAK_CASE_H

#include <string>

static const std::vector<std::string> cb_break_case_amount_unit = {"Absolute", "Percentage"};
static const std::vector<std::string> cb_break_case_statements = {"Equals to", "Greater than", "Lesser than"};

struct BreakCase {
  BreakCase(std::string id_name, std::string considered_attr, std::string ammount_unit,
            int ammount,  std::string statement_type, std::string statement_value) {
    m_id_name         = id_name;
    m_considered_attr = considered_attr;
    m_ammount_unit    = ammount_unit;
    m_ammount         = ammount;
    m_statement_type  = statement_type;
    m_statement_value = statement_value;
  }

  std::string m_id_name;
  std::string m_considered_attr;
  std::string m_ammount_unit;
  int         m_ammount;
  std::string m_statement_type;
  std::string m_statement_value;
};

#endif // BREAK_CASE_H
