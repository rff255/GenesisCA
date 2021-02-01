// ImGui - standalone example application for Glfw + OpenGL 2, using fixed pipeline
// If you are new to ImGui, see examples/README.txt and documentation at the top of imgui.cpp.

//#include "ca_test.h"
#include "ca_dll.h"

#include "imgui/imgui.h"
#include "imgui/imgui_impl_glfw.h"
#include "imgui/glfw/glfw3.h"
#include <string.h>     //strcpy
#include "bitmap_image.hpp"

#define MAX_ENUM_NAME_LENGTH    84
#define  INDEX(i, j) ((i)*(ca_width)*3 + (j*3))

static void error_callback(int error, const char* description) {
    fprintf(stderr, "Error %d: %s\n", error, description);
}

int main(int, char**)
{
    Genesis::CAModel TESTCAModel;

    // Setup window
    glfwSetErrorCallback(error_callback);
    if (!glfwInit())
        return 1;
    GLFWwindow* window = glfwCreateWindow(1000, 640, ("Genesis Model Simulator - " + TESTCAModel.name).c_str(), NULL, NULL);
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

    bool play = false;
    bool show = true;
    float ratioPixelCell = 2;
    char img_path[MAX_ENUM_NAME_LENGTH];
    img_path[0] = '\0';
    strcpy(img_path, "C:/Users/Rodrigo/Desktop/diffusion_img_test2.bmp");

    char save_img_path[MAX_ENUM_NAME_LENGTH];
    save_img_path[0] = '\0';
    strcpy(save_img_path, "my_snapshot.bmp");

    ImVec4 clear_color = ImColor(114, 144, 154);

    // GENESIS TEST
    int ca_width = 200;
    int ca_height = 200;

    //Genesis::CAModel TESTCAModel;

    TESTCAModel.Init(ca_width, ca_height);

    // Give the image data to OpenGL
    //float CATexture[ca_height][ca_width][3];
    float* CATexture = new float[3*ca_width*ca_height];
    int* TestView = new int[3 * ca_width*ca_height];

    GLuint textureID;
    glGenTextures(1, &textureID);
    glBindTexture(GL_TEXTURE_2D, textureID);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_REPEAT);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_REPEAT);

    // Draw options
    ImVec2 origin;
    ImVec2 mousePos;
    int   brushSize[2]  = {10, 10};
    float brushColor[3] = { 0.5, 0.5, 0.5};

    // Curr options
    vector<string> availableInputMappings   = TESTCAModel.GetInputMappingNames();
    vector<string> availableOutputMappings  = TESTCAModel.GetOutputMappingNames();
    vector<string> availableModelAttributes = TESTCAModel.GetModelAttributeNames();

    int currViewIndex = 0;
    string currViewMode = availableOutputMappings[currViewIndex];

    int currInputMappingIndex = 0;
    string currInputMapping = availableInputMappings[currInputMappingIndex];

    vector<char[MAX_ENUM_NAME_LENGTH]> modelAttrParams(availableModelAttributes.size());
    for (int i = 0; i < availableModelAttributes.size(); ++i) strcpy(&modelAttrParams[i][0], TESTCAModel.GetModelAttributeByName(availableModelAttributes[i]).c_str());

    // GENESIS TEST
    int generation = 0;
    int resized_width;
    int resized_height;
    float board_screen_ratio = 0.7;
    // Main loop
    while (!glfwWindowShouldClose(window))
    {
      glfwPollEvents();
      ImGui_ImplGlfw_NewFrame();

      glfwGetWindowSize(window, &resized_width, &resized_height);
      ImGui::SetNextWindowSize(ImVec2(resized_width, resized_height), ImGuiSetCond_Always);
      ImGui::SetNextWindowPos(ImVec2(0, 0), ImGuiSetCond_Once);
      //ImGui::SetNextWindowSizeConstraints(ImVec2(resized_width, resized_height), ImVec2(resized_width, resized_height));
      ImGui::Begin("MainWindow", nullptr, ImGuiWindowFlags_NoResize |
        ImGuiWindowFlags_NoMove |
        ImGuiWindowFlags_NoCollapse |
        ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoScrollbar);
      //ImGuiWindowFlags_AlwaysHorizontalScrollbar |
      //ImGuiWindowFlags_AlwaysVerticalScrollbar);

      ImGui::SetNextWindowSize(ImVec2(resized_width, resized_height), ImGuiSetCond_Always);
      ImGui::SetNextWindowPos(ImVec2(0, 0), ImGuiSetCond_Once);

      // ######## Board
      ImGui::BeginChild("Simulation", ImVec2(resized_width - 10, resized_height*board_screen_ratio), true, ImGuiWindowFlags_AlwaysHorizontalScrollbar |
                                                                                                           ImGuiWindowFlags_AlwaysVerticalScrollbar);
      origin = ImGui::GetCursorScreenPos();
      ImGui::Image((GLuint*)textureID, ImVec2(ca_width*ratioPixelCell, ca_height*ratioPixelCell));
      ImGui::Text("Generation = %d", generation);
      ImGui::EndChild();

      // Brush draw
      if (ImGui::IsMouseClicked(0, true)) {
        mousePos = ImGui::GetMousePos();
        //std::cout << "OriX = " << origin.x << " OriY = " << origin.y << std::endl;
        //std::cout << "X = " << mousePos.x << " Y = " << mousePos.y << std::endl;
        //ImVec2 dragDelta = ImGui::GetMouseDragDelta();
        //std::cout << "dragDeltaX = " << dragDelta.x << "dragDeltaY = " << dragDelta.y << std::endl;
        if (mousePos.y < resized_height*board_screen_ratio-10) {
          mousePos.x -= origin.x;
          mousePos.y -= origin.y;
          mousePos.x = static_cast<int>(mousePos.x / ratioPixelCell);
          mousePos.y = static_cast<int>(mousePos.y / ratioPixelCell);

          if (mousePos.x >= 0 && mousePos.x < ca_width &&
              mousePos.y >= 0 && mousePos.y < ca_height) {
            //TESTCAModel.LoadColorCellByName(currInputMapping, mousePos.y, mousePos.x, 100, 0, 0);

            for (int x = -brushSize[0]; x < brushSize[0]; ++x)
            for (int y = -brushSize[1]; y < brushSize[1]; ++y)
            if (mousePos.x + x >= 0 && mousePos.x + x < ca_width &&
                mousePos.y + y >= 0 && mousePos.y + y < ca_height)
              TESTCAModel.LoadColorCellByName(currInputMapping, mousePos.y + y, mousePos.x + x, static_cast<int>(brushColor[0]*255), static_cast<int>(brushColor[1]*255), static_cast<int>(brushColor[2]*255));

            TESTCAModel.StepForth();
            TESTCAModel.GetViewerByName(currViewMode, TestView);
            for (int i = 0; i < ca_height; ++i) {
              for (int j = 0; j < ca_width; ++j) {
                CATexture[INDEX(i, j) + 0] = TestView[INDEX(i, j) + 0] / 255.0;
                CATexture[INDEX(i, j) + 1] = TestView[INDEX(i, j) + 1] / 255.0;
                CATexture[INDEX(i, j) + 2] = TestView[INDEX(i, j) + 2] / 255.0;
              }
            }
            glTexImage2D(GL_TEXTURE_2D, 0, GL_RGB, ca_width, ca_height, 0, GL_RGB, GL_FLOAT, CATexture);
          }
        }
      }

      // ########

      // ######## Execution Options
      ImGui::BeginChild("Configuration", ImVec2(resized_width/2 - 10, resized_height*(1 - board_screen_ratio) - 10), true, ImGuiWindowFlags_AlwaysHorizontalScrollbar |
                                                                                                                           ImGuiWindowFlags_AlwaysVerticalScrollbar);

      if (ImGui::Button("StepForth")){
        generation++;
        play = false;
        TESTCAModel.StepForth();
        TESTCAModel.GetViewerByName(currViewMode, TestView);
        for (int i = 0; i < ca_height; ++i) {
          for (int j = 0; j < ca_width; ++j) {
            CATexture[INDEX(i, j) + 0] = TestView[INDEX(i, j) + 0] / 255.0;
            CATexture[INDEX(i, j) + 1] = TestView[INDEX(i, j) + 1] / 255.0;
            CATexture[INDEX(i, j) + 2] = TestView[INDEX(i, j) + 2] / 255.0;
          }
        }
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGB, ca_width, ca_height, 0, GL_RGB, GL_FLOAT, CATexture);
      }
      ImGui::SameLine();
      if (ImGui::Button("Clear")) {
        generation = 0;
        //play = false;
        TESTCAModel.Clear();
        TESTCAModel.GetViewerByName(currViewMode, TestView);
        for (int i = 0; i < ca_height; ++i) {
          for (int j = 0; j < ca_width; ++j) {
            CATexture[INDEX(i, j) + 0] = TestView[INDEX(i, j) + 0] / 255.0;
            CATexture[INDEX(i, j) + 1] = TestView[INDEX(i, j) + 1] / 255.0;
            CATexture[INDEX(i, j) + 2] = TestView[INDEX(i, j) + 2] / 255.0;
          }
        }
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGB, ca_width, ca_height, 0, GL_RGB, GL_FLOAT, CATexture);
      }

      ImGui::SameLine();
      if (play){
        ImGui::PushStyleColor(ImGuiColorEditMode_RGB, ImVec4(0.9, 0.1, 0.1, 1));
        if (ImGui::Button("Pause"))
          play = false;
        ImGui::PopStyleColor();
      }
      else {
        ImGui::PushStyleColor(ImGuiColorEditMode_RGB, ImVec4(0.1, 0.9, 0.1, 1));
        if (ImGui::Button("Play"))
          play = true;
        ImGui::PopStyleColor();
      }

      if (play) {
        generation++;
        TESTCAModel.StepForth();
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGB, ca_width, ca_height, 0, GL_RGB, GL_FLOAT, CATexture);
      }

      ImGui::SameLine();
      ImGui::Checkbox("Show", &show);
      if (show) {
        TESTCAModel.GetViewerByName(currViewMode, TestView);
        for (int i = 0; i < ca_height; ++i) {
          for (int j = 0; j < ca_width; ++j) {
            CATexture[INDEX(i, j) + 0] = TestView[INDEX(i, j) + 0] / 255.0;
            CATexture[INDEX(i, j) + 1] = TestView[INDEX(i, j) + 1] / 255.0;
            CATexture[INDEX(i, j) + 2] = TestView[INDEX(i, j) + 2] / 255.0;
          }
        }
      }

      // Zoom (Ratio pixel/cell)
      ImGui::Separator();
      ImGui::Text("Ratio pixel / cell:");
      ImGui::PushItemWidth(resized_width / 2 - 30);
      ImGui::SliderFloat("##Ratio pixel/cell", &ratioPixelCell, 1, 10, "%.1f");

      // Board Size
      ImGui::PushItemWidth(resized_width / 10);
      if (ImGui::DragInt("Board Width", &ca_width, 1, 10) |
          ImGui::DragInt("Board Height", &ca_height, 1, 10)){
        // Reinicialize CA
        TESTCAModel.Init(ca_width, ca_height);

        // Free allocated memory
        delete[] CATexture;
        delete[] TestView;

        // Re allocate
        CATexture = new float[3 * ca_width*ca_height];
        TestView = new int[3 * ca_width*ca_height];
      }

        // Views
        ImGui::Separator();
        ImGui::Text("Available Views: ");
        for (int i = 0; i < availableOutputMappings.size(); ++i){
          if (ImGui::RadioButton(availableOutputMappings[i].c_str(), &currViewIndex, i)){
            currViewMode = availableOutputMappings[currViewIndex];
          }
          ImGui::SameLine();
        }
        ImGui::NewLine();

        // Save snapshot
        if (ImGui::Button("Save Snapshot")) {
          bitmap_image snapshot(ca_width, ca_height);
          int* snapshotView = new int[3 * ca_width*ca_height];
          TESTCAModel.GetViewerByName(currViewMode, snapshotView);

          rgb_t colour;
          for (int i = 0; i < ca_height; ++i)
          for (int j = 0; j < ca_width; ++j){
            snapshot.set_pixel(j, i, colour);
            colour.red   = snapshotView[INDEX(i, j) + 0];
            colour.green = snapshotView[INDEX(i, j) + 1];
            colour.blue  = snapshotView[INDEX(i, j) + 2];
            snapshot.set_pixel(j, i, colour);
          }

          snapshot.save_image(save_img_path);
        }

        ImGui::SameLine();
        ImGui::Text("Path:");
        ImGui::SameLine();
        ImGui::PushItemWidth(resized_width / 3);
        ImGui::InputText("##Path", save_img_path, MAX_ENUM_NAME_LENGTH);

        ImGui::EndChild();
        // ########

        // ######## Cells Interaction
        ImGui::SameLine();
        ImGui::BeginChild("Interaction", ImVec2(resized_width/2 - 10, resized_height*(1 - board_screen_ratio) - 10), true, ImGuiWindowFlags_AlwaysHorizontalScrollbar |
          ImGuiWindowFlags_AlwaysVerticalScrollbar);

        // Brush properties
        ImGui::PushItemWidth(resized_width / 7);
        ImGui::ColorEdit3("BrushColor", brushColor);
        ImGui::SameLine();
        ImGui::PushItemWidth(resized_width / 10);
        ImGui::DragInt2("Brush Size", brushSize,1,1,ca_width);

        // Popup image not found
        if (ImGui::BeginPopup("ImgNotFound"))
        {
          ImGui::Text("Choose a valid image...");
          ImGui::EndPopup();
        }

        // Popup incompatible board size
        if (ImGui::BeginPopup("IncompatibleImageSize"))
        {
          //ImGui::Text("The chosen image has size %dx%d", image.width(), image.height());
          ImGui::Text("Reinitialized Board and adjusted size to fit the desired image");
          ImGui::EndPopup();
        }
        //

        // Input Mappings
        ImGui::Text("Available Input Mappings: ");
        for (int input = 0; input < availableInputMappings.size(); ++input) {
          if (ImGui::RadioButton(availableInputMappings[input].c_str(), &currInputMappingIndex, input)){
            currInputMapping = availableInputMappings[currInputMappingIndex];
          }
          ImGui::SameLine();
        }

        ImGui::NewLine();
        if (ImGui::Button("Load Image")) {
          bitmap_image image(img_path);
          if (!image)
            ImGui::OpenPopup("ImgNotFound");
          else
          {
            // Check if current board size is of same size than loaded image
            if (image.width() != ca_width || image.height() != ca_height) {
              ImGui::OpenPopup("IncompatibleImageSize");
              ca_width  = image.width();
              ca_height = image.height();

              TESTCAModel.Init(ca_width, ca_height);

              // Free allocated memory
              delete[] CATexture;
              delete[] TestView;

              // Re allocate
              CATexture = new float[3 * ca_width*ca_height];
              TestView = new int[3 * ca_width*ca_height];
            }

            rgb_t colour;
            for (int i = 0; i < ca_height; ++i)
              for (int j = 0; j < ca_width; ++j){
                image.get_pixel(j, i, colour);
                TESTCAModel.LoadColorCellByName(currInputMapping, i, j, colour.red, colour.green, colour.blue);
                generation = 0;
              }
          }
        }

        ImGui::SameLine();
        ImGui::Text("Path:");
        ImGui::SameLine();
        ImGui::PushItemWidth(resized_width/3);
        ImGui::InputText("##Path", img_path, MAX_ENUM_NAME_LENGTH);

        // Model Attributes
        ImGui::Separator();
        ImGui::Text("Available Model Attribute Parameters: ");
        for (int i = 0; i < availableModelAttributes.size(); ++i){
          ImGui::PushItemWidth(resized_width/10);
          if (ImGui::InputText(availableModelAttributes[i].c_str(), &modelAttrParams[i][0], MAX_ENUM_NAME_LENGTH, ImGuiInputTextFlags_CharsNoBlank | ImGuiInputTextFlags_AutoSelectAll)){
            if (string(modelAttrParams[i]) == "")
              strcpy(&modelAttrParams[i][0], "0\0");
            TESTCAModel.SetModelAttributeByName(availableModelAttributes[i], modelAttrParams[i]);
          }
        }

        ImGui::EndChild(); // Execution options
        ImGui::End();

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

    return 0;
}
