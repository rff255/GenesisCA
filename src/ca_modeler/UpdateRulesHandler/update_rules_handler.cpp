#include "update_rules_handler.h"
#include "ui_update_rules_handler.h"

#include <qdebug.h>

#include <imgui.h>
#include "imgui_impl_glfw.h"
#include <stdio.h>
#include <GLFW/glfw3.h>
#include "imguinodegrapheditor.h"   // intellisense only
#include "node_graph_instance.h"
#include <string.h>     //strcpy

#define MAX_ENUM_NAME_LENGTH    84

UpdateRulesHandler::UpdateRulesHandler(QWidget *parent) :
  QWidget(parent),
  ui(new Ui::UpdateRulesHandler)
{
  ui->setupUi(this);
}

UpdateRulesHandler::~UpdateRulesHandler()
{
  delete ui;
}
static void error_callback(int error, const char* description)
{
    qDebug()<< stderr << "Error %d: %s\n" << error << description;
}

void UpdateRulesHandler::on_pbtn_open_node_graph_editor_released()
{
  // Setup window
  glfwSetErrorCallback(error_callback);

  if (!glfwInit())
      qDebug()<< stderr << "GLFW nao conseguiu inicializar, e agora jose?";

  GLFWwindow* window = glfwCreateWindow(1280, 720, "ImGui OpenGL2 example", NULL, NULL);
  glfwMakeContextCurrent(window);

  // Setup ImGui binding
  ImGui_ImplGlfw_Init(window, true);

  // Load Fonts
  // (there is a default font, this is only if you want to change it. see extra_fonts/README.txt for more details)
  //ImGuiIO& io = ImGui::GetIO();
  //io.Fonts->AddFontDefault();
  //io.Fonts->AddFontFromFileTTF("../../extra_fonts/Cousine-Regular.ttf", 15.0f);
  //io.Fonts->AddFontFromFileTTF("../../extra_fonts/DroidSans.ttf", 16.0f);
  //io.Fonts->AddFontFromFileTTF("../../extra_fonts/ProggyClean.ttf", 13.0f);
  //io.Fonts->AddFontFromFileTTF("../../extra_fonts/ProggyTiny.ttf", 10.0f);
  //io.Fonts->AddFontFromFileTTF("c:\\Windows\\Fonts\\ArialUni.ttf", 18.0f, NULL, io.Fonts->GetGlyphRangesJapanese());

  bool show_test_window = true;
  bool show_another_window = false;
  bool basicNodeGraph = false;
  bool dinamicEnumNodeGraph = false;
  float numero = 10;
  char novoAttr[MAX_ENUM_NAME_LENGTH];
  novoAttr[0] = '\0';
  char addedAttr[MAX_ENUM_NAME_LENGTH];
  addedAttr[0] = '\0';

  ImVec4 clear_color = ImColor(114, 144, 154);

  // Initialize Node graph editor nge (add initial nodes conections and so on)
  InitNGE();

  // Main loop
  while (!glfwWindowShouldClose(window))
  {
      glfwPollEvents();
      ImGui_ImplGlfw_NewFrame();

      // 1. Show a simple window
      // Tip: if we don't call ImGui::Begin()/ImGui::End() the widgets appears in a window automatically called "Debug"
      {
          static float f = 0.0f;
          ImGui::Text("Hello, world!");
          ImGui::SliderFloat("float", &f, 0.0f, 1.0f);
          ImGui::ColorEdit3("clear color", (float*)&clear_color);
          if (ImGui::Button("Test Window")) show_test_window ^= 1;
          if (ImGui::Button("Another Window")) show_another_window ^= 1;
          if (ImGui::Button("Node Graph Editor")) basicNodeGraph ^= 1;
          if (ImGui::Button("Dinamic bla bla Graph Editor")) dinamicEnumNodeGraph ^= 1;
          ImGui::Text("Application average %.3f ms/frame (%.1f FPS)", 1000.0f / ImGui::GetIO().Framerate, ImGui::GetIO().Framerate);
      }

      if (basicNodeGraph) {
        ImGui::SetNextWindowSize(ImVec2(500, 300), ImGuiSetCond_FirstUseEver);
        ImGui::Begin("Node Graph Editor do sucesso", &basicNodeGraph);


        if (ImGui::InputText("New item", novoAttr, MAX_ENUM_NAME_LENGTH, ImGuiInputTextFlags_EnterReturnsTrue)){
          TestEnumNamesInsert(novoAttr);
          strncpy(addedAttr, novoAttr, MAX_ENUM_NAME_LENGTH);
        }
        ImGui::Text("Novo Atributo = %s", addedAttr);
        //ImGui::TestNodeGraphEditor();
        ImGui::End();
      }

      if (dinamicEnumNodeGraph) {
        ImGui::SetNextWindowSize(ImVec2(500, 300), ImGuiSetCond_FirstUseEver);
        ImGui::Begin("Beringela", &dinamicEnumNodeGraph);
        //ImGui::Text("DELICIA DE ABACAXI");
        nge.render();
        ImGui::End();
      }

      // 2. Show another simple window, this time using an explicit Begin/End pair
      if (show_another_window)
      {
        //ImGui::TestNodeGraphEditor();   // see its code for further info
        //static bool open = true;
        //if (ImGui::Begin("Node Graph Editor", &open, ImVec2(1190, 710), 0.85f, ImGuiWindowFlags_NoScrollbar | ImGuiWindowFlags_NoScrollWithMouse | ImGuiWindowFlags_NoSavedSettings))

        //ImGui::SetNextWindowSize(ImVec2(500, 300));
        //ImGui::Begin("Beringela", &show_another_window);
        //nge.render();
        //ImGui::End();

          ImGui::SetNextWindowSize(ImVec2(200,100), ImGuiSetCond_FirstUseEver);
          ImGui::Begin("Another Window", &show_another_window);
          ImGui::Text("Hello");
          ImGui::End();
      }

      // 3. Show the ImGui test window. Most of the sample code is in ImGui::ShowTestWindow()
      if (show_test_window)
      {
          ImGui::SetNextWindowPos(ImVec2(650, 20), ImGuiSetCond_FirstUseEver);
          ImGui::ShowTestWindow(&show_test_window);
      }

      // Rendering
      int display_w, display_h;
      glfwGetFramebufferSize(window, &display_w, &display_h);
      glViewport(0, 0, display_w, display_h);
      glClearColor(clear_color.x, clear_color.y, clear_color.z, clear_color.w);
      glClear(GL_COLOR_BUFFER_BIT);
      ImGui::Render();
      glfwSwapBuffers(window);
  }

  // Cleanup
  ImGui_ImplGlfw_Shutdown();
  glfwTerminate();
}
