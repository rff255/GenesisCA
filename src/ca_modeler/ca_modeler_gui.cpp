#include "ca_modeler_gui.h"
#include "ui_ca_modeler_gui.h"
#include "attribute_handler_widget.h"
#include "vicinity_handler_widget.h"

#include <QMessageBox>
#include <QFileDialog>
#include <QDebug>
#include <QDir>

#include <fstream>
#include <stdlib.h>

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
  ui->wgt_attribute_handler->set_m_ca_model(m_ca_model);
  ui->wgt_model_properties_handler->set_m_ca_model(m_ca_model);
  ui->wgt_vicinities_handler->set_m_ca_model(m_ca_model);
  ui->wgt_update_rules_handler->set_m_ca_model(m_ca_model);
  ui->wgt_color_mappings_handler->set_m_ca_model(m_ca_model);
}

// Slots:

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
