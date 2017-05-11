#include "ca_model.h"
#include <string>
#include <vector>

using std::string;
using std::vector;

CAModel::CAModel():
m_model_properties(new ModelProperties()),
mGraphEditor(new UpdateRulesEditor()) {}

CAModel::~CAModel() {
  delete m_model_properties;
  delete mGraphEditor;
}

// Attributes
string CAModel::AddAttribute(Attribute* new_attr) {
  string base_id_name = new_attr->m_id_name;
  int disambiguity_number = 1;
  while(m_attributes.count(new_attr->m_id_name) > 0) {
    new_attr->m_id_name = base_id_name + std::to_string(disambiguity_number);
    disambiguity_number++;
  }

  m_attributes[new_attr->m_id_name] = new_attr;
  return new_attr->m_id_name;
}

bool CAModel::DelAttribute(string id_name) {
  auto entry = m_attributes.find(id_name);

  if(entry == m_attributes.end())
    return false;

  delete m_attributes[id_name];
  m_attributes.erase(entry);

  return true;
}

string CAModel::ModifyAttribute(string prev_id_name, Attribute *modified_attr) {
  if(prev_id_name == modified_attr->m_id_name) {
    m_attributes[prev_id_name] = modified_attr;
    return prev_id_name;
  }

  else {
    DelAttribute(prev_id_name);
    return AddAttribute(modified_attr);
  }
}

Attribute *CAModel::GetAttribute(string id_name) {
  if(m_attributes.find(id_name) == m_attributes.end())
    return nullptr;
  else
    return m_attributes[id_name];
}

vector<string> CAModel::GetAttributesList() {
  vector<string> attr_id_name_list;
  for(auto kv : m_attributes)
      attr_id_name_list.push_back(kv.first);

  return attr_id_name_list;
}

vector<string> CAModel::GetCellAttributesList()
{
  vector<string> attr_id_name_list;
  for(auto kv : m_attributes)
      if(!GetAttribute(kv.first)->m_is_model_attribute)
        attr_id_name_list.push_back(kv.first);

  return attr_id_name_list;
}

vector<string> CAModel::GetModelAttributesList()
{
  vector<string> attr_id_name_list;
  for(auto kv : m_attributes)
      if(GetAttribute(kv.first)->m_is_model_attribute)
        attr_id_name_list.push_back(kv.first);

  return attr_id_name_list;
}

// BreakCases
string CAModel::AddBreakCase(BreakCase *new_bc) {
  string base_id_name = new_bc->m_id_name;
  int disambiguity_number = 1;
  while(m_break_cases.count(new_bc->m_id_name) > 0) {
    new_bc->m_id_name = base_id_name + std::to_string(disambiguity_number);
    disambiguity_number++;
  }

  m_break_cases[new_bc->m_id_name] = new_bc;
  return new_bc->m_id_name;
}

bool CAModel::DelBreakCase(string id_name) {
  auto entry = m_break_cases.find(id_name);

  if(entry == m_break_cases.end())
    return false;

  delete m_break_cases[id_name];
  m_break_cases.erase(entry);

  return true;
}

string CAModel::ModifyBreakCase(string prev_id_name, BreakCase *modified_bc) {
  if(prev_id_name == modified_bc->m_id_name) {
    m_break_cases[prev_id_name] = modified_bc;
    return prev_id_name;
  }

  else {
    DelBreakCase(prev_id_name);
    return AddBreakCase(modified_bc);
  }
}

BreakCase *CAModel::GetBreakCase(string id_name) {
  if(m_break_cases.find(id_name) == m_break_cases.end())
    return nullptr;
  else
    return m_break_cases[id_name];
}

// Model Properties
void CAModel::ModifyModelProperties(
    const string &name, const string &author, const string &goal,
    const string &description, const string &topology, const string &boundary_treatment,
    bool is_fixed_size, int size_width, int size_height, const string &cell_attribute_initialization,
    bool has_max_iterations, int max_iterations) {

  m_model_properties->m_name = name;
  m_model_properties->m_author = author;
  m_model_properties->m_goal = goal;
  m_model_properties->m_description = description;

  m_model_properties->m_topology = topology;
  m_model_properties->m_boundary_treatment = boundary_treatment;
  m_model_properties->m_is_fixed_size = is_fixed_size;
  m_model_properties->m_size_width = size_width;
  m_model_properties->m_size_height = size_height;

  m_model_properties->m_cell_attributes_initialization = cell_attribute_initialization;
  m_model_properties->m_has_max_iterations = has_max_iterations;
  m_model_properties->m_max_iterations = max_iterations;

  // TODO(figueiredo): add Break cases into scheme
}

// Neighborhoods
string CAModel::AddNeighborhood(Neighborhood* new_neigh) {
  string base_id_name = new_neigh->m_id_name;
  int disambiguity_number = 1;
  while(m_neighborhoods.count(new_neigh->m_id_name) > 0) {
    new_neigh->m_id_name = base_id_name + std::to_string(disambiguity_number);
    disambiguity_number++;
  }

  m_neighborhoods[new_neigh->m_id_name] = new_neigh;
  return new_neigh->m_id_name;
}

bool CAModel::DelNeighborhood(string id_name) {
  auto entry = m_neighborhoods.find(id_name);

  if(entry == m_neighborhoods.end())
    return false;

  delete m_neighborhoods[id_name];
  m_neighborhoods.erase(entry);

  return true;
}

string CAModel::ModifyNeighborhood(string prev_id_name, Neighborhood* modified_neigh) {
  if(prev_id_name == modified_neigh->m_id_name) {
    m_neighborhoods[prev_id_name] = modified_neigh;
    return prev_id_name;
  }

  else {
    DelNeighborhood(prev_id_name);
    return AddNeighborhood(modified_neigh);
  }
}

Neighborhood *CAModel::GetNeighborhood(string id_name) {
  if(m_neighborhoods.find(id_name) == m_neighborhoods.end())
    return nullptr;
  else
    return m_neighborhoods[id_name];
}

vector<string> CAModel::GetNeighborhoodList() {
  vector<string> neigh_id_name_list;
  for(auto kv : m_neighborhoods)
      neigh_id_name_list.push_back(kv.first);

  return neigh_id_name_list;
}

// Mappings
string CAModel::AddMapping(Mapping* new_map) {
  string base_id_name = new_map->m_id_name;
  int disambiguity_number = 1;
  while(m_mappings.count(new_map->m_id_name) > 0) {
    new_map->m_id_name = base_id_name + std::to_string(disambiguity_number);
    disambiguity_number++;
  }

  m_mappings[new_map->m_id_name] = new_map;
  return new_map->m_id_name;
}

bool CAModel::DelMapping(string id_name) {
  auto entry = m_mappings.find(id_name);

  if(entry == m_mappings.end())
    return false;

  delete m_mappings[id_name];
  m_mappings.erase(entry);

  return true;
}

string CAModel::ModifyMapping(string prev_id_name, Mapping *modified_map) {
  if(prev_id_name == modified_map->m_id_name) {
    m_mappings[prev_id_name] = modified_map;
    return prev_id_name;
  }

  else {
    DelMapping(prev_id_name);
    return AddMapping(modified_map);
  }
}

Mapping *CAModel::GetMapping(string id_name) {
  if(m_mappings.find(id_name) == m_mappings.end())
    return nullptr;
  else
    return m_mappings[id_name];
}

vector<string> CAModel::GetMappingsList() {
  vector<string> map_id_name_list;
  for(auto kv : m_mappings)
      map_id_name_list.push_back(kv.first);

  return map_id_name_list;
}

vector<string> CAModel::GetColAttrMappingsList()
{
  vector<string> map_id_name_list;
  for(auto kv : m_mappings)
      if(!GetMapping(kv.first)->m_is_attr_color)
        map_id_name_list.push_back(kv.first);

  return map_id_name_list;
}

vector<string> CAModel::GetAttrColMappingsList()
{
  vector<string> map_id_name_list;
  for(auto kv : m_mappings)
      if(GetMapping(kv.first)->m_is_attr_color)
        map_id_name_list.push_back(kv.first);

  return map_id_name_list;
}

// Nodes Graph Editor (##Code Generation## )
std::string CAModel::GenerateHCode()
{
  string code = "";

  // Namespaces, includes and typedefs
  code += "#pragma once\n\n";
  code += GenerateIncludesList() + "\n";
  code += "namespace Genesis {\n";
  code += "namespace CA_"+ m_model_properties->m_name +" {\n\n";
  code += GenerateTypedefList() + "\n";

  // Forward declaration
  code += "class CACell;\n";
  code += "class CAModel;\n";

  code += "// Cell Declaration\n";
  code += GenerateCACellDeclaration();
  code += "\n// Model Declaration\n";
  code += GenerateCAModelDeclaration();

  // End of namespaces
  code += "\n}  // namespace_Genesis\n";
  code += "}  // namespace_CA_"+ m_model_properties->m_name +"\n";

  return code;
}

std::string CAModel::GenerateCPPCode()
{
  string code = "";

  // Namespaces, includes and typedefs
  code += "#include <ca_"+ m_model_properties->m_name +".h>\n\n";

  code += GenerateIncludesList()+ "\n";
  code += "namespace Genesis {\n";
  code += "namespace CA_"+ m_model_properties->m_name +" {\n\n";
  code += GenerateTypedefList() + "\n";

  code += "// ### Cell Definitions\n";
  code += GenerateCACellDefinition();

  code += "// ### Model Definitions\n";
  code += GenerateCAModelDefinition();

  // End of namespaces
  code += "}  // namespace_Genesis\n";
  code += "}  // namespace_CA_"+ m_model_properties->m_name +"\n";

  return code;
}

string CAModel::GenerateCACellDeclaration()
{
  string code = "";
  code += "class CACell {\n";
  code += " public:\n";

  // Constructor and destructor
  code += "CACell():";
  vector<string> attrList = GetCellAttributesList();
  for(int i=0; i<attrList.size(); ++i){
    if(i != 0)
      code += ", ";
    code += "ATTR_"+attrList[i]+"(0)";
  }
  code += "{}\n";
  code += "~CACell(){}\n";

  // Copy previous configuration function
  code += "void CopyPrevCellConfig();\n";

  // Default initialization function
  code += "void DefaultInit();\n";

  // Color initializations
  for(string inputMapping: GetColAttrMappingsList())
    code += "void InputColor_"+ inputMapping +"(int red, int green, int blue);\n";

  // Step function
  code += "void Step();\n";

  // Accessors (Attributes and Viewers)
  code += "\n";
  for(string attr: GetCellAttributesList())
    code += attr+"_TYPE Get"+ attr + "() {return this->ATTR_"+attr+";}\n";

  for(string viewer: GetAttrColMappingsList())
    code += "void Get"+ viewer + "(int* outColor) {outColor[0] = VIEWER_"+viewer+"[0]; outColor[1] = VIEWER_"+viewer+"[1]; outColor[2] = VIEWER_"+viewer+"[2];}\n";

  // Mutators (Attributes)
  for(string attr: GetCellAttributesList())
    code += "void Set"+ attr + "("+attr+"_TYPE val) {this->ATTR_"+attr+" = val;}\n";

  // Members (PrevCell, CAModel, Attributes, neighborhoods, viewers)
  code += "\n";
  code += "CACell* prevCell;\n";
  code += "CAModel* CAModel;\n";
  for(string attr: GetCellAttributesList())
    code += attr+"_TYPE ATTR_"+ attr + ";\n";

  for(string neighborhood: GetNeighborhoodList())
    code += "vector<CACell*> NEIGHBORS_"+ neighborhood + ";\n";

  for(string viewer: GetAttrColMappingsList())
    code += "int VIEWER_"+ viewer + "[3];\n";

  code += "};\n";
  return code;
}

string CAModel::GenerateCACellDefinition()
{
  string code = "";
  // Copy previous configuration function
  code += "void CACell::CopyPrevCellConfig(){\n";
  for(string attr: GetCellAttributesList())
    code += "  ATTR_"+attr+" = prevCell->ATTR_"+ attr + ";\n";
  for(string viewer: GetAttrColMappingsList())
    code += "  prevCell->Get"+ viewer + "(VIEWER_"+viewer+");\n";
  code += "}\n\n";

  code += mGraphEditor->EvalGraphEditorDefaultInit()+ "\n";
  code += mGraphEditor->EvalGraphEditorInputColorNodes()+ "\n";
  code += mGraphEditor->EvalGraphEditorStep()+ "\n";
  return code;
}

string CAModel::GenerateCAModelDeclaration()
{
  string code = "";
  code += "class CAModel {\n";
  code += " public:\n";

  // Constructor and destructor
  code += "CAModel():";
  vector<string> modelAttrList = GetModelAttributesList();
  for(int i=0; i<modelAttrList.size(); ++i){
    if(i != 0)
      code += ", ";
    code += "ATTR_"+modelAttrList[i]+"("+ GetAttribute(modelAttrList[i])->m_init_value +")";
  }
  code += "{}\n";
  code += "~CAModel(){}\n";

//  // Copy previous configuration function
//  code += "void CopyPrevCellConfig();\n";

//  // Default initialization function
//  code += "void DefaultInit();\n";

//  // Color initializations
//  for(string inputMapping: GetColAttrMappingsList())
//    code += "void InputColor_"+ inputMapping +"(int red, int green, int blue);\n";

//  // Step function
//  code += "void Step();\n";

//  // Accessors (Attributes and Viewers)
//  code += "\n";
//  for(string attr: GetCellAttributesList())
//    code += attr+"_TYPE Get"+ attr + "() {return this->ATTR_"+attr+";}\n";

//  for(string viewer: GetAttrColMappingsList())
//    code += "void Get"+ viewer + "(int* outColor) {outColor[0] = VIEWER_"+viewer+"[0]; outColor[1] = VIEWER_"+viewer+"[1]; outColor[2] = VIEWER_"+viewer+"[2];}\n";

//  // Mutators (Attributes)
//  for(string attr: GetCellAttributesList())
//    code += "void Set"+ attr + "("+attr+"_TYPE val) {this->ATTR_"+attr+" = val;}\n";

//  // Members (PrevCell, CAModel, Attributes, neighborhoods, viewers)
//  code += "\n";
//  code += "CACell* prevCell;\n";
//  code += "CAModel* CAModel;\n";
//  for(string attr: GetCellAttributesList())
//    code += attr+"_TYPE ATTR_"+ attr + ";\n";

//  for(string neighborhood: GetNeighborhoodList())
//    code += "vector<CACell*> NEIGHBORS_"+ neighborhood + ";\n";

//  for(string viewer: GetAttrColMappingsList())
//    code += "int VIEWER_"+ viewer + "[3];\n";

  code += "};\n";
  return code;
}

string CAModel::GenerateCAModelDefinition() {
  return "//Nothing here (yet)";
}

std::string CAModel::GenerateTypedefList() {
  string code = "";
  code += "// Typedefs mapping attribute types into C++ types\n";
  // Mapping attribute types into C++ types
  for(int i=0;i<cb_attribute_type_values.size(); ++i)
    code += "typedef " + attribute_type_cpp_equivalent[i]+ " "+ cb_attribute_type_values[i] + ";\n";

  code += "\n";
  // Mapping each attribute types macro into it respectively type
  for(string attr: GetAttributesList())
    code += "typedef " +GetAttribute(attr)->m_type+ " "+ attr + "_TYPE;\n";

  return code;
}

std::string CAModel::GenerateIncludesList() {
  string code = "";
  code += "#include <algorithm>\n";
  code += "#include <math>\n";
  code += "#include <random>\n";
  code += "#include <time.h>\n";
  code += "#include <vector>\n\n";
  code += "using std::vector;\n";
 return code;
}
