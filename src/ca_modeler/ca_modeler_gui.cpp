#include "ca_modeler_gui.h"
#include "ui_ca_modeler_gui.h"
#include "attribute_handler_widget.h"
#include "vicinity_handler_widget.h"

#include "../JSON_nlohmann/json.hpp"

#include <QMessageBox>
#include <QFileDialog>
#include <QDebug>
#include <QDir>

#include <fstream>
#include <stdlib.h>

using json = nlohmann::json;
CAModelerGUI::CAModelerGUI(QWidget *parent) :
  QMainWindow(parent),
  ui(new Ui::CAModelerGUI),
  m_ca_model(new CAModel()) {
    ui->setupUi(this);

    // Setup widgets
    SetupWidgets();

    // Pass model reference to promoted widgets
    PassModel();

    // Connect Signals and Slots
    // Attribute change results in refresh model properties
    connect(ui->wgt_attribute_handler, SIGNAL(AttributeAdded(std::string)), ui->wgt_model_properties_handler, SLOT(AddModelAttributesInitItem(std::string)));
    connect(ui->wgt_attribute_handler, SIGNAL(AttributeRemoved(std::string)), ui->wgt_model_properties_handler, SLOT(DelModelAttributesInitItem(std::string)));
    connect(ui->wgt_attribute_handler, SIGNAL(AttributeChanged(std::string, std::string)), ui->wgt_model_properties_handler, SLOT(ChangeModelAttributesInitItem(std::string,std::string)));

    // Update GraphEditor after list of attributes change
    connect(ui->wgt_attribute_handler,      SIGNAL(AttributeListChanged()),    ui->wgt_update_rules_handler, SLOT(UpdateEditorComboBoxes()));
    connect(ui->wgt_vicinities_handler,     SIGNAL(NeighborhoodListChanged()), ui->wgt_update_rules_handler, SLOT(UpdateEditorComboBoxes()));
    connect(ui->wgt_color_mappings_handler, SIGNAL(MappingListChanged()),      ui->wgt_update_rules_handler, SLOT(UpdateEditorComboBoxes()));
}

CAModelerGUI::~CAModelerGUI() {
  delete ui;
}

void CAModelerGUI::SetupWidgets() {
  // Attributes tab
  ui->wgt_attribute_handler->ConfigureCB();

  // Model Properties tab
  ui->wgt_model_properties_handler->ConfigureCB();
}

void CAModelerGUI::PassModel() {
  ui->wgt_model_properties_handler->set_m_ca_model(m_ca_model);
  ui->wgt_attribute_handler->set_m_ca_model(m_ca_model);
  ui->wgt_vicinities_handler->set_m_ca_model(m_ca_model);
  ui->wgt_update_rules_handler->set_m_ca_model(m_ca_model);
  ui->wgt_color_mappings_handler->set_m_ca_model(m_ca_model);
}

// Slots:
void CAModelerGUI::on_act_open_triggered() {
  QFileDialog open(this, tr("Open..."), "", tr("GenesisCA Project (*.gcaproj)"));
  open.setFileMode(QFileDialog::ExistingFile);
  open.setAcceptMode(QFileDialog::AcceptOpen);

  json deserialized_data;
  if(open.exec()) {
    QString filename = open.selectedFiles().first();

    //QFile file(filename);
    //if (file.open(QFile::ReadOnly | QFile::Text)) {
      std::ifstream stream(filename.toStdString());
      deserialized_data << stream;
      stream.close();

      // Replace current model by the deserialized one.
      auto old_ca_model = m_ca_model;
      m_ca_model = new CAModel();
      m_ca_model->InitFromSerializedData(deserialized_data);
      this->PassModel();
      delete old_ca_model;

      QMessageBox::information(this, "Project Open", "Project successfully opened.");
    //} else {
    //  qDebug() << "file open error";
    //}
  }



//  // DELETE ME (just testing how the gui reacts if the model is not empty when the screens are being initialized)
//  auto old_ca_model = m_ca_model;
//  m_ca_model = new CAModel();
//  m_ca_model->ModifyModelProperties("jujubas", "Jubileu", "Be happy and test if widgets sync", "nothing here", "Torus");
//  m_ca_model->AddAttribute(new Attribute("brush_probability", cb_attribute_type_values[2], "Controls the probability of set to alive", "0.31415", true));
//  m_ca_model->AddAttribute(new Attribute("born_probability", cb_attribute_type_values[2], "bla", "0.5", true));
//  m_ca_model->AddAttribute(new Attribute("alive", cb_attribute_type_values[0], "Stores if the cell is alive", "false", false));
//  std::vector<std::pair<int, int>> neighbor_coords;

//  neighbor_coords.push_back(std::pair<int,int>(-1, 0));
//  neighbor_coords.push_back(std::pair<int,int>(2, 0));
//  neighbor_coords.push_back(std::pair<int,int>(0, -3));
//  neighbor_coords.push_back(std::pair<int,int>(0, 4));
//  m_ca_model->AddNeighborhood(new Neighborhood("skewed_cross", "Up, down, left and right", neighbor_coords));

//  m_ca_model->AddMapping(new Mapping("show_alive", "show which cells are alive in black", "nothing special", "idem", "idem", true));
//  m_ca_model->AddMapping(new Mapping("set_alive", "Set cells as alive or dead", "if > 0 then set the cell as 'alive' otherwise set as 'dead'", "does nothing", "does nothing", false));

//  nlohmann::json default_rules = nlohmann::json::parse("{\"editor_setup\":null,\"links\":[{\"link_in_node\":2,\"link_in_port\":0,\"link_out_node\":11,\"link_out_port\":0},{\"link_in_node\":11,\"link_in_port\":0,\"link_out_node\":12,\"link_out_port\":0},{\"link_in_node\":6,\"link_in_port\":0,\"link_out_node\":4,\"link_out_port\":0},{\"link_in_node\":7,\"link_in_port\":0,\"link_out_node\":4,\"link_out_port\":1},{\"link_in_node\":5,\"link_in_port\":0,\"link_out_node\":12,\"link_out_port\":1},{\"link_in_node\":12,\"link_in_port\":0,\"link_out_node\":1,\"link_out_port\":0},{\"link_in_node\":3,\"link_in_port\":0,\"link_out_node\":1,\"link_out_port\":1},{\"link_in_node\":9,\"link_in_port\":0,\"link_out_node\":13,\"link_out_port\":1},{\"link_in_node\":12,\"link_in_port\":1,\"link_out_node\":13,\"link_out_port\":0},{\"link_in_node\":10,\"link_in_port\":0,\"link_out_node\":8,\"link_out_port\":0},{\"link_in_node\":10,\"link_in_port\":1,\"link_out_node\":0,\"link_out_port\":0},{\"link_in_node\":11,\"link_in_port\":1,\"link_out_node\":10,\"link_out_port\":0},{\"link_in_node\":5,\"link_in_port\":0,\"link_out_node\":10,\"link_out_port\":1}],\"nodes\":[{\"node_data\":\"{\\\"mFirstNumberF\\\":0.0,\\\"mFirstNumberI\\\":0,\\\"mProbability\\\":0.0,\\\"mSecondNumberF\\\":0.0,\\\"mSecondNumberI\\\":0,\\\"mSelectedAttrIndex\\\":0,\\\"mUseModelAttr\\\":true,\\\"mValueType\\\":0}\",\"node_id\":7,\"node_pos\":[-43.0,-13.5],\"node_type\":5},{\"node_data\":\"{\\\"mSelectedAttrIndex\\\":0}\",\"node_id\":1,\"node_pos\":[596.0,169.5],\"node_type\":8},{\"node_data\":\"\",\"node_id\":2,\"node_pos\":[-501.0,184.0],\"node_type\":0},{\"node_data\":\"{\\\"mFirstNumberF\\\":0.0,\\\"mFirstNumberI\\\":0,\\\"mProbability\\\":0.0,\\\"mSecondNumberF\\\":0.0,\\\"mSecondNumberI\\\":0,\\\"mSelectedAttrIndex\\\":1,\\\"mUseModelAttr\\\":true,\\\"mValueType\\\":0}\",\"node_id\":9,\"node_pos\":[-23.0,368.5],\"node_type\":5},{\"node_data\":\"{\\\"mSelectedAttrIndex\\\":0}\",\"node_id\":4,\"node_pos\":[174.0,-55.5],\"node_type\":8},{\"node_data\":\"{\\\"mSelectedAttrIndex\\\":0}\",\"node_id\":5,\"node_pos\":[-221.0,219.5],\"node_type\":2},{\"node_data\":\"{\\\"mSelectedMapping\\\":0}\",\"node_id\":6,\"node_pos\":[-228.0,-51.5],\"node_type\":16},{\"node_data\":\"{\\\"mFirstNumberF\\\":0.0,\\\"mFirstNumberI\\\":0,\\\"mProbability\\\":0.9099999666213989,\\\"mSecondNumberF\\\":0.0,\\\"mSecondNumberI\\\":0,\\\"mSelectedAttrIndex\\\":0,\\\"mUseModelAttr\\\":false,\\\"mValueType\\\":0}\",\"node_id\":3,\"node_pos\":[374.0,207.5],\"node_type\":5},{\"node_data\":\"{\\\"mDefaultColor\\\":[0.019607843831181526,0.03921568766236305,0.0784313753247261],\\\"mSelectedMapping\\\":0,\\\"mUseDefaultColor\\\":true}\",\"node_id\":8,\"node_pos\":[-234.0,365.5],\"node_type\":17},{\"node_data\":\"{\\\"mDefaultColor\\\":[1.0,0.9607843160629272,0.9215686321258545],\\\"mSelectedMapping\\\":0,\\\"mUseDefaultColor\\\":true}\",\"node_id\":0,\"node_pos\":[-228.0,525.5],\"node_type\":17},{\"node_data\":\"\",\"node_id\":10,\"node_pos\":[-417.0,367.5],\"node_type\":9},{\"node_data\":\"\",\"node_id\":11,\"node_pos\":[-355.0,187.5],\"node_type\":11},{\"node_data\":\"\",\"node_id\":12,\"node_pos\":[-14.0,174.0],\"node_type\":9},{\"node_data\":\"{\\\"mSelectedAttrIndex\\\":0}\",\"node_id\":13,\"node_pos\":[197.0,325.5],\"node_type\":8}]}");

//  m_ca_model->SetGraphEditor(default_rules);

//  this->PassModel();
//  delete old_ca_model;
//  // DELETE ME (just testing how the gui reacts if the model is not empty when the screens are being initialized)
}

void CAModelerGUI::on_act_saveas_triggered() {
  QFileDialog save_as(this, tr("Save As..."), "", tr("GenesisCA Project (*.gcaproj)"));
  save_as.setFileMode(QFileDialog::AnyFile);
  save_as.setAcceptMode(QFileDialog::AcceptSave);
  save_as.setDefaultSuffix(".gcaproj");

  if(save_as.exec()) {
    QString filename = save_as.selectedFiles().first();

    //QFile file(filename);
    //if (file.open(QIODevice::WriteOnly)) {
      std::ofstream stream(filename.toStdString());
      stream << m_ca_model->GetSerializedData().dump() << std::endl;
      stream.close();

      QMessageBox::information(this, "Project Saved", "Project successfully saved.");
    //} else {
    //  qDebug() << "file open error";
    //}
  }
}

void CAModelerGUI::on_act_quit_triggered() {
  // TODO(figueiredo): check for unsaved changes and open dialog asking for confirmation
  QApplication::quit();
}

void CAModelerGUI::on_act_export_c_code_triggered()
{
  ExportCodeFiles();
//  std::string toBePrinted = "//#### Generated Header: ####\n" +
//                            m_ca_model->GenerateHCode() +
//                            "//#### Generated Implementation: ####\n" +
//                            m_ca_model->GenerateCPPCode() +
//                            "//####\n";

//  qDebug(toBePrinted.c_str());
}

void CAModelerGUI::on_act_run_triggered()
{
  // Get the "working directory" where (the party begins) files are generated and compiled
  std::string SAfolder = QApplication::applicationDirPath().toStdString() + "/StandaloneApplication/";
// THIS FOLDER MUST EXIST, so, doesnt make sense to create one
//  QDir dir(QApplication::applicationDirPath() + "/StandaloneApplication/");
//  if (!dir.exists()) {
//      dir.mkpath(".");
//  }

  // Get the "run directory" where will be created the .exe
  std::string runPath = QApplication::applicationDirPath().toStdString() + "/StandaloneApplication/runDir";
  QDir runDir(QApplication::applicationDirPath() + "/StandaloneApplication/runDir");
  if (!runDir.exists()) {
      runDir.mkpath(".");
  }

  if(ui->action_DEV_Use_Preexisting_Code->isChecked())
  {
    printf("using preexisting code...\n");
  }
  else
  {
    // H DLL file
    std::ofstream hDllFile;
    hDllFile.open ((SAfolder + "ca_dll.h").c_str());
    hDllFile << m_ca_model->GenerateHDLLCode();
    hDllFile.close();

    // CPP DLL file
    std::ofstream cppDllFile;
    cppDllFile.open ((SAfolder + "ca_dll.cpp").c_str());
    cppDllFile << m_ca_model->GenerateCPPDLLCode();
    cppDllFile.close();
  }

  // Generate standalone application
  system(("cl /GL /O2 /Oi /I "+SAfolder+" "+SAfolder+"*.cpp glfw3dll.lib opengl32.lib "+" /link /LTCG /OPT:REF /OPT:ICF /OUT:"+SAfolder+"/StandaloneApplication.exe /incremental:no /LIBPATH:"+ SAfolder).c_str());

  // To overwrite
  if (QFile::exists((runPath +"/StandaloneApplication.exe").c_str()))
      QFile::remove((runPath +"/StandaloneApplication.exe").c_str());

  if (QFile::exists((runPath +"/glfw3.dll").c_str()))
      QFile::remove((runPath +"/glfw3.dll").c_str());

  // Get the useful files
  QFile::copy(QString((SAfolder+"StandaloneApplication.exe").c_str()), QString((runPath +"/StandaloneApplication.exe").c_str()));
  QFile::copy(QString((SAfolder+"glfw3.dll").c_str()), QString((runPath +"/glfw3.dll").c_str()));

  // Clear unnecessary files
  if(!ui->action_DEV_Use_Preexisting_Code->isChecked()) {
    QFile::remove(QString((SAfolder + "ca_dll.h").c_str()));
    QFile::remove(QString((SAfolder + "ca_dll.cpp").c_str()));
  }
  QFile::remove(QString((SAfolder+"StandaloneApplication.exe").c_str()));
  QFile::remove(QString((SAfolder+"StandaloneApplication.exp").c_str()));
  QFile::remove(QString((SAfolder+"StandaloneApplication.lib").c_str()));

  // Run generated standalone Application
  system((runPath +"/StandaloneApplication.exe").c_str());
}

void CAModelerGUI::on_act_generate_standalone_viewer_triggered()
{
  // Select a directory to export
  QString OutputPath = QFileDialog::getExistingDirectory (this, "Export Standalone Application Directory");
  if ( OutputPath.isNull())
  {
    QMessageBox::information(this, "Invalid Path", "Model not exported. Select a valid path.");
    return;
  }

  // Get the "working directory" where (the party begins) files are generated and compiled
  std::string SAfolder = QApplication::applicationDirPath().toStdString() + "/StandaloneApplication/";

// THIS FOLDER MUST EXIST, so, doesnt make sense to create one
//  QDir dir(QApplication::applicationDirPath() + "/StandaloneApplication/");
//  if (!dir.exists()) {
//      dir.mkpath(".");
//  }

  if(ui->action_DEV_Use_Preexisting_Code->isChecked())
  {
    printf("using preexisting code...\n");
  }
  else
  {
    // H DLL file
    std::ofstream hDllFile;
    hDllFile.open ((SAfolder + "ca_dll.h").c_str());
    hDllFile << m_ca_model->GenerateHDLLCode();
    hDllFile.close();

    // CPP DLL file
    std::ofstream cppDllFile;
    cppDllFile.open ((SAfolder + "ca_dll.cpp").c_str());
    cppDllFile << m_ca_model->GenerateCPPDLLCode();
    cppDllFile.close();
  }

  // Generate standalone application
  system(("cl /GL /O2 /Oi /I "+SAfolder+" "+SAfolder+"*.cpp glfw3dll.lib opengl32.lib "+" /link /LTCG /OPT:REF /OPT:ICF /OUT:"+SAfolder+"/StandaloneApplication.exe /incremental:no /LIBPATH:"+ SAfolder).c_str());

  // To overwrite
  if (QFile::exists((OutputPath.toStdString()+"/StandaloneApplication.exe").c_str()))
      QFile::remove((OutputPath.toStdString()+"/StandaloneApplication.exe").c_str());

  if (QFile::exists((OutputPath.toStdString()+"/glfw3.dll").c_str()))
      QFile::remove((OutputPath.toStdString()+"/glfw3.dll").c_str());

  // Get the useful files
  QFile::copy(QString((SAfolder+"StandaloneApplication.exe").c_str()), QString((OutputPath.toStdString()+"/StandaloneApplication.exe").c_str()));
  QFile::copy(QString((SAfolder+"glfw3.dll").c_str()), QString((OutputPath.toStdString()+"/glfw3.dll").c_str()));

  // Clear unnecessary files
  if(!ui->action_DEV_Use_Preexisting_Code->isChecked()) {
    QFile::remove(QString((SAfolder + "ca_dll.h").c_str()));
    QFile::remove(QString((SAfolder + "ca_dll.cpp").c_str()));
  }
  QFile::remove(QString((SAfolder+"StandaloneApplication.exe").c_str()));
  QFile::remove(QString((SAfolder+"StandaloneApplication.exp").c_str()));
  QFile::remove(QString((SAfolder+"StandaloneApplication.lib").c_str()));

  QMessageBox::information(this, "Standalone Application Successfully Exported!  ", "Hurray!.");
}

void CAModelerGUI::ExportCodeFiles() {
  // Get the "working directory" where files are compiled
  QString OutputPath = QFileDialog::getExistingDirectory (this, "Export Code Directory");
  if ( OutputPath.isNull())
  {
    QMessageBox::information(this, "Invalid Path", "Code not exported. Select a valid path.");
    return;
  }

  // Get the "working directory" where files are generated
  std::string SAfolder = QApplication::applicationDirPath().toStdString() + "/StandaloneApplication/";
  QDir dir(QApplication::applicationDirPath() + "SAfolder");
  if (!dir.exists()) {
      dir.mkpath(".");
  }

  std::string modelName = "ca_"+m_ca_model->GetModelProperties()->m_name;

  // To overwrite
  if (QFile::exists((OutputPath.toStdString()+modelName+".h").c_str()))
      QFile::remove((OutputPath.toStdString()+modelName+".h").c_str());

  if (QFile::exists((OutputPath.toStdString()+modelName+".cpp").c_str()))
      QFile::remove((OutputPath.toStdString()+modelName+".cpp").c_str());

  // H file
  std::ofstream hFile;
  hFile.open ((SAfolder + modelName +".h").c_str());
  hFile << m_ca_model->GenerateHCode();
  hFile.close();

  // CPP file
  std::ofstream cppFile;
  cppFile.open ((SAfolder + modelName +".cpp").c_str());
  cppFile << m_ca_model->GenerateCPPCode();
  cppFile.close();

  // Get the useful files
  QFile::copy(QString((SAfolder+ modelName+".h").c_str()), QString((OutputPath.toStdString()+"/"+modelName+".h").c_str()));
  QFile::copy(QString((SAfolder+ modelName+".cpp").c_str()), QString((OutputPath.toStdString()+"/"+modelName+".cpp").c_str()));

  // Clear unnecessary files
  QFile::remove(QString((SAfolder+modelName+".h").c_str()));
  QFile::remove(QString((SAfolder+modelName+".cpp").c_str()));

  QMessageBox::information(this, "Code Successfully Exported!  ", "Nothing to say.");
}

void CAModelerGUI::on_act_export_dll_triggered()
{
  // Select a directory to export
  QString OutputPath = QFileDialog::getExistingDirectory (this, "Export DLL Directory");
  if ( OutputPath.isNull())
  {
    QMessageBox::information(this, "Invalid Path", "DLL not exported. Select a valid path.");
    return;
  }

  // Get the "working directory" where (the party begins) files are generated and compiled
  std::string SAfolder = QApplication::applicationDirPath().toStdString() + "/StandaloneApplication/";

// THIS FOLDER MUST EXIST, so, doesnt make sense to create one
//  QDir dir(QApplication::applicationDirPath() + "/StandaloneApplication/");
//  if (!dir.exists()) {
//      dir.mkpath(".");
//  }

  // H DLL file
  std::ofstream hDllFile;
  hDllFile.open ((SAfolder + "ca_dll.h").c_str());
  hDllFile << m_ca_model->GenerateHDLLCode();
  hDllFile.close();

  // CPP DLL file
  std::ofstream cppDllFile;
  cppDllFile.open ((SAfolder + "ca_dll.cpp").c_str());
  cppDllFile << m_ca_model->GenerateCPPDLLCode();
  cppDllFile.close();

  // To overwrite
  if (QFile::exists((OutputPath.toStdString()+"/ca_dll.dll").c_str()))
      QFile::remove((OutputPath.toStdString()+"/ca_dll.dll").c_str());

  // Generate model DLL
  system(("cl /DCA_DLL "+SAfolder+"/ca_dll.cpp /LD /Fo"+OutputPath.toStdString()+"/ca_dll.dll").c_str());

  // Clear unnecessary files
  QFile::remove(QString((SAfolder + "ca_dll.h").c_str()));
  QFile::remove(QString((SAfolder + "ca_dll.cpp").c_str()));

  QMessageBox::information(this, "DLL Successfully Exported!  ", "Hurray!.");
}
