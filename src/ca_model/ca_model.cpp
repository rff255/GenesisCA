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
std::string CAModel::GenerateHDLLCode()
{
  string code = "";

  // Namespaces, includes and typedefs
  code += "#pragma once\n\n";

  code += "#define CA_DLL\n";

  code += "#ifdef CA_DLL\n";
  code += "#define CA_DLL_API __declspec(dllexport)\n";
  code += "#else\n";
  code += "#define CA_DLL_API __declspec(dllimport)\n";
  code += "#endif\n\n";

  code += GenerateIncludesList() + "\n";
  code += "namespace Genesis {\n";
  code += GenerateTypedefList() + "\n";

  // Forward declaration
  code += "class CACell;\n";
  code += "class CAModel;\n";

  code += "// Cell Declaration\n";
  code += GenerateCACellDeclaration(true);
  code += "\n// Model Declaration\n";
  code += GenerateCAModelDeclaration(true);

  // End of namespaces
  code += "\n}  // namespace_Genesis\n";

  return code;
}

std::string CAModel::GenerateCPPDLLCode()
{
  string code = "";

  // Namespaces, includes and typedefs
  code += "#include \"ca_dll.h\"\n\n";

  code += GenerateIncludesList()+ "\n";
  code += "#define CAINDEX1C(i, j) ((i)*(CAWidth) + (j))\n";
  code += "#define CAINDEX3C(i, j) ((i)*(CAWidth)*3 + (j*3))\n";

  code += "namespace Genesis {\n";
  code += GenerateTypedefList() + "\n";

  code += "// ### Cell Definitions\n";
  code += GenerateCACellDefinition();

  code += "// ### Model Definitions\n";
  code += GenerateCAModelDefinition();

  // End of namespaces
  code += "}  // namespace_Genesis\n";

  code += "#undef CAINDEX1C\n";
  code += "#undef CAINDEX3C\n";

  return code;
}

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
  code += "#include \"ca_"+ m_model_properties->m_name +".h\"\n\n";

  code += GenerateIncludesList()+ "\n";
  code += "#define CAINDEX1C(i, j) ((i)*(CAWidth) + (j))\n";
  code += "#define CAINDEX3C(i, j) ((i)*(CAWidth)*3 + (j*3))\n";

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

  code += "#undef CAINDEX1C\n";
  code += "#undef CAINDEX3C\n";

  return code;
}

string CAModel::GenerateCACellDeclaration(bool toDLL)
{
  string code = "";
  if(toDLL)
    code += "class CA_DLL_API CACell {\n";
  else
    code += "class CACell {\n";
  code += " public:\n";

  // Constructor and destructor
  code += "CACell(){\n  Clear();\n}\n";
  code += "~CACell(){}\n";

  // Clear function (returns to default values, calling DefaultInit execution if there is one)
  code += "void Clear(){\n";
  for(string attr: GetCellAttributesList())
    code += "  ATTR_"+attr+ " = 0;\n";
  for(string viewer: GetAttrColMappingsList()){
    code += "  VIEWER_"+viewer+ "[0] = 0;\n";
    code += "  VIEWER_"+viewer+ "[1] = 0;\n";
    code += "  VIEWER_"+viewer+ "[2] = 0;\n";
  }
  code += "}\n";

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
    code += "void GetViewer"+ viewer + "(int* outColor) {outColor[0] = VIEWER_"+viewer+"[0]; outColor[1] = VIEWER_"+viewer+"[1]; outColor[2] = VIEWER_"+viewer+"[2];}\n";

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
    code += "  prevCell->GetViewer"+ viewer + "(VIEWER_"+viewer+");\n";
  code += "}\n\n";

  code += mGraphEditor->EvalGraphEditorDefaultInit()+ "\n";
  code += mGraphEditor->EvalGraphEditorInputColorNodes()+ "\n";
  code += mGraphEditor->EvalGraphEditorStep()+ "\n";
  return code;
}

string CAModel::GenerateCAModelDeclaration(bool toDLL)
{
  string code = "";
  if(toDLL)
    code += "class CA_DLL_API CAModel {\n";
  else
    code += "class CAModel {\n";
  code += " public:\n";
  code += "  CAModel();\n";
  code += "  ~CAModel();\n\n";

  code += "  // Init (defines the dimensions of grid, allocate memory and initiate the cells)\n";
  code += "  void Init(int width, int height);\n";

  code += "\n  // Get for each Cell Attribute\n";
  for(string attr: GetCellAttributesList())
    code += "  void Get"+attr+"("+attr+"_TYPE* outValues);\n";

  code += "\n  // Set for each Cell Attribute\n";
  for(string attr: GetCellAttributesList())
    code += "  void Set"+attr+"("+attr+"_TYPE* values);\n";

  code += "\n  // Get for each Model Attribute\n";
  for(string attr: GetModelAttributesList())
    code += "  "+attr+"_TYPE Get"+attr+"();\n";

  code += "\n  // Set for each Model Attribute\n";
  for(string attr: GetModelAttributesList())
    code += "  void Set"+attr+"("+attr+"_TYPE value);\n";

  code += "\n  // Get for each Viewer\n";
  for(string viewer: GetAttrColMappingsList())
    code += "  void GetViewer"+viewer+"(int* outValues);\n";

  code += "\n  // Load color in one cell for each input color mapping\n";
  for(string inputCol: GetColAttrMappingsList())
    code += "  void LoadColorCell"+inputCol+"(int row, int col, int red, int green, int blue);\n";

  code += "\n  // Load color image for each input color mapping\n";
  for(string inputCol: GetColAttrMappingsList())
    code += "  void LoadColorImage"+inputCol+"(int* rgbMatrix);\n";

  code += "\n  // Clear\n";
  code += "  void Clear();\n";

  code += "\n  // Break cases check - test stop conditions\n";
  code += "  bool BreakCasesCheck() {return true;}\n";

  code += "\n  // Precompute the neighbors references of each cell\n";
  code += "  void PreComputeNeighbors();\n";

  code += "  void StepForth(); // One iteration\n";
  code += "  void StepBy(int num); // @num iterations\n";
  code += "  void StepToEnd(); // Until reach the end\n";

  code += "  vector<string> GetModelAttributeNames();\n";
  code += "  vector<string> GetInputMappingNames();\n";
  code += "  vector<string> GetOutputMappingNames();\n";

  code += "  string GetModelAttributeByName(string attrName);\n";
  code += "  bool SetModelAttributeByName(string attrName, string value);\n";
  code += "  bool GetViewerByName(string viewerName, int* rgbMatrix);\n";
  code += "  bool LoadColorImageByName(string initColorName, int* rgbMatrix);\n";
  code += "  bool LoadColorCellByName(string initColorName, int row, int col, int r, int g, int b);\n";

  code += "\n  // Simulation variables\n";
  code += "  CACell*** currBoard;\n";
  code += "  CACell*** prevBoard;\n";
  code += "  CACell* defaultCell;\n";
  code += "  int CAWidth;\n";
  code += "  int CAHeight;\n";

  code += "\n  // Model Properties\n";
  code += "  string name;\n";
  code += "  string author;\n";
  code += "  string goal;\n";
  code += "  string description;\n";
  code += "  string boundaryType;\n";

  code += "\n  // Model Attributes\n";
  for(string modelAttr: GetModelAttributesList())
    code += "  "+modelAttr+"_TYPE ATTR_"+ modelAttr+ ";\n";

  code += "\n  // Neighborhood types\n";
  for(string neighborhood: GetNeighborhoodList())
    code += "  vector<pair<int,int>> NEIGHBORHOOD_"+neighborhood+";\n";

  code += "};\n";
  return code;
}

string CAModel::GenerateCAModelDefinition() {
  string code = "";
  string ind  = "  ";

  // ## Constructor
  code += "CAModel::CAModel() {\n";
  code += ind+ "std::srand(time(NULL));\n";
  code += ind+ "this->name = \""+GetModelProperties()->m_name+"\";\n";
  code += ind+ "this->author = \""+GetModelProperties()->m_author+"\";\n";
  code += ind+ "this->goal = \""+GetModelProperties()->m_goal+"\";\n";
  code += ind+ "this->description = \""+GetModelProperties()->m_description+"\";\n";
  code += ind+ "this->boundaryType = \""+GetModelProperties()->m_boundary_treatment+"\";\n";
  code += "\n";
  for(string modelAttr: GetModelAttributesList())
    code += ind+"this->ATTR_"+modelAttr+" = "+ GetAttribute(modelAttr)->m_init_value+ ";\n";
  code += "\n";
  for(string neighborhood: GetNeighborhoodList()){
    code += ind+"// "+neighborhood+"\n";
    Neighborhood* currNeighborhood = GetNeighborhood(neighborhood);
    for(int i=0; i< currNeighborhood->m_neighbor_coords->size(); ++i)
      code += ind+"this->NEIGHBORHOOD_"+neighborhood+".push_back(pair<int,int>("+ std::to_string((*currNeighborhood->m_neighbor_coords)[i].first)+ ", "+std::to_string((*currNeighborhood->m_neighbor_coords)[i].second)+"));\n";
  }
  code += "\n";
  code += ind+"this->defaultCell = new CACell();\n";
  code += ind+"this->defaultCell->CAModel = this;\n";
  code += ind+"this->defaultCell->DefaultInit();\n";
  code += ind+"CAWidth = 0;\n";
  code += ind+"CAHeight = 0;\n";
  code += "}\n";

  // ## Destructor
  code += "\nCAModel::~CAModel() {\n";
  code += ind+"delete this->defaultCell;\n";
  code += ind+"for (int i = 0; i < CAHeight; ++i){\n";
  code += ind+ind+"delete [] currBoard[i];\n";
  code += ind+ind+"delete [] prevBoard[i];\n";
  code += ind+"}\n";
  code += ind+"delete [] currBoard;\n";
  code += ind+"delete [] prevBoard;\n";
  code += "}\n";

  // ## Init
  code += "void CAModel::Init(int width, int height) {\n" +
    ind+ "CAWidth  = width;\n" +
    ind+ "CAHeight = height;\n" +

    ind+ "// First allocate the boards cells\n" +
    ind+ "this->currBoard = new CACell**[CAHeight];\n" +
    ind+ "for (int i = 0; i < CAHeight; ++i)\n" +
    ind+ "    currBoard[i] = new CACell*[CAWidth];\n" +
    "\n" +
    ind+ "this->prevBoard = new CACell**[CAHeight];\n" +
    ind+ "for (int i = 0; i < CAHeight; ++i)\n" +
    ind+ "    prevBoard[i] = new CACell*[CAWidth];\n" +
    "\n" +
    ind+ "// Then create each cell\n" +
    ind+ "for (int i = 0; i < CAHeight; ++i)\n" +
    ind+ "  for (int j = 0; j < CAWidth; ++j) {\n" +
    ind+ "    currBoard[i][j] = new CACell();\n" +
    ind+ "    prevBoard[i][j] = new CACell();\n" +
    ind+ "  }\n" +
    "\n" +
    ind+ "// Finally, compute the neighborhood references for each cell, and call the default init\n" +
    ind+ "PreComputeNeighbors();\n" +
    ind+ "for (int i = 0; i < CAHeight; ++i)\n" +
    ind+ "  for (int j = 0; j < CAWidth; ++j) {\n" +
    ind+ "    currBoard[i][j]->DefaultInit();\n" +
    ind+ "    prevBoard[i][j]->DefaultInit();\n" +
    ind+ "  }\n" +
  "}\n";

  // ## Gets and Sets of Cell and Model attributes
  code += "\n";
  for(string attr: GetCellAttributesList()) {
    code +=
    "void CAModel::Get"+attr+"("+attr+"_TYPE* outValues) {\n"+
    ind+ "for (int i = 0; i < CAHeight; ++i)\n" +
    ind+ "  for (int j = 0; j < CAWidth; ++j) {\n" +
    ind+ "    outValues[CAINDEX1C(i, j)] = prevBoard[i][j]->Get"+attr+"();\n" +
    ind+ "  }\n" +
    "}\n";
  }
  code += "\n";
  for(string attr: GetCellAttributesList()) {
    code +=
    "void CAModel::Set"+attr+"("+attr+"_TYPE* values) {\n"+
    ind+ "for (int i = 0; i < CAHeight; ++i)\n" +
    ind+ "  for (int j = 0; j < CAWidth; ++j) {\n" +
    ind+ "    currBoard[i][j]->Set"+attr+"(values[CAINDEX1C(i, j)]);\n" +
    ind+ "    prevBoard[i][j]->Set"+attr+"(values[CAINDEX1C(i, j)]);\n" +
    ind+ "  }\n" +
    "}\n";
  }

  code += "\n";
  for(string attr: GetModelAttributesList()) {
    code +=
      attr+"_TYPE CAModel::Get"+attr+"() {\n  return this->ATTR_"+attr+";\n}\n";
  }

  code += "\n";
  for(string attr: GetModelAttributesList()) {
    code +=
      "void CAModel::Set"+attr+"("+attr+"_TYPE value) {\n  this->ATTR_"+attr+" = value;\n}\n";
  }

  // ## Gets and Sets of Mappings
  code += "\n";
  for(string viewer: GetAttrColMappingsList()) {
    code +=
    "void CAModel::GetViewer"+viewer+"(int* outValues) {\n"+
    ind+ "for (int i = 0; i < CAHeight; ++i)\n" +
    ind+ "  for (int j = 0; j < CAWidth; ++j)\n" +
    ind+ "    prevBoard[i][j]->GetViewer"+viewer+"(&outValues[CAINDEX3C(i,j)]);\n" +
    "}\n";
  }
  code += "\n";
  for(string mapping: GetColAttrMappingsList()) {
    code +=
    "void CAModel::LoadColorCell"+mapping+"(int row, int col, int red, int green, int blue) {\n"+
    "  currBoard[row][col]->InputColor_"+mapping+"(red, green, blue);\n" +
    "  prevBoard[row][col]->InputColor_"+mapping+"(red, green, blue);\n" +
    "}\n";
  }
  code += "\n";
  for(string mapping: GetColAttrMappingsList()) {
    code +=
    "void CAModel::LoadColorImage"+mapping+"(int* rgbMatrix) {\n"+
    ind+ "for (int i = 0; i < CAHeight; ++i)\n" +
    ind+ "  for (int j = 0; j < CAWidth; ++j) {\n" +
    ind+ "    currBoard[i][j]->InputColor_"+mapping+"(rgbMatrix[CAINDEX3C(i, j)+0], rgbMatrix[CAINDEX3C(i, j)+1], rgbMatrix[CAINDEX3C(i, j)+2]);\n" +
    ind+ "    prevBoard[i][j]->InputColor_"+mapping+"(rgbMatrix[CAINDEX3C(i, j)+0], rgbMatrix[CAINDEX3C(i, j)+1], rgbMatrix[CAINDEX3C(i, j)+2]);\n" +
    ind+ "  }\n" +
    "}\n";
  }
  code += "\n";
  code += "void CAModel::Clear() {\n"+
    ind+"for (int i = 0; i < CAHeight; ++i)\n"+
    ind+"  for (int j = 0; j < CAWidth; ++j) {\n"+
    ind+"    currBoard[i][j]->Clear();\n"+
    ind+"    prevBoard[i][j]->Clear();\n"+
    ind+"    currBoard[i][j]->DefaultInit();\n"+
    ind+"    prevBoard[i][j]->DefaultInit();\n"+
    ind+"  }\n"+
  "}\n";
  code += "\n";

  code += "void CAModel::PreComputeNeighbors() {\n"+
    ind+"for (int i = 0; i < CAHeight; ++i)\n" +
    ind+"  for (int j = 0; j < CAWidth; ++j) {\n" +
    ind+"    currBoard[i][j]->prevCell = prevBoard[i][j];\n" +
    ind+"    prevBoard[i][j]->prevCell = currBoard[i][j];\n" +
    ind+"    currBoard[i][j]->CAModel  = this;\n" +
    ind+"    prevBoard[i][j]->CAModel  = this;\n" +
    "\n";

    for(string neighborhood: GetNeighborhoodList()){
      code += ind+"    // "+neighborhood+" user-defined neighborhood\n" +
    ind+"    for(int n=0; n < NEIGHBORHOOD_"+neighborhood+".size(); ++n) {\n" +
    ind+"       int rowIndex = (i + NEIGHBORHOOD_"+neighborhood+"[n].second);\n" +
    ind+"       int colIndex = (j + NEIGHBORHOOD_"+neighborhood+"[n].first);\n" +
    ind+"       // Border treatment\n" +
    ind+"       if(rowIndex < 0 || rowIndex >= CAHeight || colIndex < 0 || colIndex >= CAWidth) {\n" +
    ind+"         if(this->boundaryType == \"Torus\") {\n" +
    ind+"           rowIndex = rowIndex<0 ? CAHeight+rowIndex%CAHeight : rowIndex%CAHeight;\n" +
    ind+"           colIndex = colIndex<0 ? CAWidth+colIndex%CAWidth : colIndex%CAWidth;\n" +
    ind+"           currBoard[i][j]->NEIGHBORS_"+neighborhood+".push_back(prevBoard[rowIndex][colIndex]);\n" +
    ind+"           prevBoard[i][j]->NEIGHBORS_"+neighborhood+".push_back(currBoard[rowIndex][colIndex]);\n" +
    ind+"         } else {\n" +
    ind+"           prevBoard[i][j]->NEIGHBORS_"+neighborhood+".push_back(this->defaultCell);\n" +
    ind+"           currBoard[i][j]->NEIGHBORS_"+neighborhood+".push_back(this->defaultCell);\n" +
    ind+"         }\n" +
    ind+"       } else {\n" +
    ind+"         currBoard[i][j]->NEIGHBORS_"+neighborhood+".push_back(prevBoard[rowIndex][colIndex]);\n" +
    ind+"         prevBoard[i][j]->NEIGHBORS_"+neighborhood+".push_back(currBoard[rowIndex][colIndex]);\n" +
    ind+"       }\n" +
    ind+"    }\n";
    }

  code+=ind+"  }\n" +
  "}\n";
  code += "\n";

  code += "vector<string> CAModel::GetModelAttributeNames(){\n";
  code += ind+"vector<string> modelAttrNames;\n";
    for(string attrName: GetAttributesList())
      if(GetAttribute(attrName)->m_is_model_attribute)
        code += ind+"modelAttrNames.push_back(\""+attrName+"\");\n";
    code += ind+ "\nreturn modelAttrNames;\n";
  code += "}\n";
  code += "\n";

  code += "vector<string> CAModel::GetInputMappingNames(){\n";
  code += ind+"vector<string> inputMappingNames;\n";
    for(string mapName: GetColAttrMappingsList())
      code += ind+"inputMappingNames.push_back(\""+mapName+"\");\n";
    code += ind+ "\nreturn inputMappingNames;\n";
  code += "}\n";
  code += "\n";

  code += "vector<string> CAModel::GetOutputMappingNames(){\n";
  code += ind+"vector<string> outputMappingNames;\n";
    for(string mapName: GetAttrColMappingsList())
      code += ind+"outputMappingNames.push_back(\""+mapName+"\");\n";
    code += ind+ "\nreturn outputMappingNames;\n";
  code += "}\n";
  code += "\n";

  // ##  Generic function (by names)
  code += "\n";
  code += "string CAModel::GetModelAttributeByName(string attribute){\n";
    for(string attrName: GetModelAttributesList()){
      code += ind+ "if(attribute == \""+attrName+"\")\n";
      code += ind+ "  return std::to_string(this->ATTR_"+attrName+");\n";
    }
    code += ind + "return \"\";\n";
  code += "}\n";
  code += "\n";

  code += "bool CAModel::SetModelAttributeByName(string attrName, string value){\n";
    for(string attrName: GetModelAttributesList()){
      code += ind+ "if(attrName == \""+attrName+"\"){\n";
      if(GetAttribute(attrName)->m_type == "Bool")
        code += ind+ "  this->ATTR_"+attrName+" = std::stoi(value);\n";
      else if(GetAttribute(attrName)->m_type == "Integer")
        code += ind+ "  this->ATTR_"+attrName+" = std::stoi(value);\n";
      else if(GetAttribute(attrName)->m_type == "Float")
        code += ind+ "  this->ATTR_"+attrName+" = std::stof(value);\n";
      code += ind+ "  return true;\n";
      code += ind+ "}\n";
    }
    code += ind + "return false;\n";
  code += "}\n";
  code += "\n";

  code += "bool CAModel::GetViewerByName(string viewerName, int* rgbMatrix){\n";
    for(string mapName: GetAttrColMappingsList()){
      code += ind+ "if(viewerName == \""+mapName+"\"){\n";
      code += ind+ "  GetViewer"+mapName+"(rgbMatrix);\n";
      code += ind+ "  return true;\n";
      code += ind+ "}\n";
    }
    code += ind + "return false;\n";
  code += "}\n";
  code += "\n";

  code += "bool CAModel::LoadColorImageByName(string initColorName, int* rgbMatrix){\n";
    for(string mapName: GetColAttrMappingsList()){
      code += ind+ "if(initColorName == \""+mapName+"\"){\n";
      code += ind+ "  LoadColorImage"+mapName+"(rgbMatrix);\n";
      code += ind+ "  return true;\n";
      code += ind+ "}\n";
    }
    code += ind + "return false;\n";
  code += "}\n";
  code += "\n";

  code += "bool CAModel::LoadColorCellByName(string initColorName, int row, int col, int r, int g, int b){\n";
    for(string mapName: GetColAttrMappingsList()){
      code += ind+ "if(initColorName == \""+mapName+"\"){\n";
      code += ind+ "  LoadColorCell"+mapName+"(row, col, r, g, b);\n";
      code += ind+ "  return true;\n";
      code += ind+ "}\n";
    }
    code += ind + "return false;\n";
  code += "}\n";
  code += "\n";

  code +="void CAModel::StepForth() {\n" +
  ind+"for (int i = 0; i < CAHeight; ++i)\n" +
  ind+"  for (int j = 0; j < CAWidth; ++j) {\n" +
  ind+"    currBoard[i][j]->Step();\n" +
  ind+"  }\n" +
  "\n" +
  ind+"// Switch the boards -just like the double buffer opengl drawing\n" +
  ind+"std::swap(currBoard, prevBoard);\n" +
  "}\n";
  code += "\n";

  code +="void CAModel::StepBy(int num){\n" +
  ind+"for(int i=0; i<num; ++i)\n" +
  ind+"  StepForth();\n" +
  "}\n";
  code += "\n";

  code +="void CAModel::StepToEnd() {\n" +
  ind+"while(this->BreakCasesCheck())\n" +
  ind+"  StepForth();\n" +
  "}\n";

  code += "\n";
  return code;
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
  code += "#include <math.h>\n";
  code += "#include <random>\n";
  code += "#include <time.h>\n";
  code += "#include <vector>\n";
  code += "#include <string>\n\n";
  code += "using std::vector;\n";
  code += "using std::string;\n";
  code += "using std::pair;\n";
 return code;
}
